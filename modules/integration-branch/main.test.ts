import { afterEach, describe, expect, test } from "bun:test";
// Bun has no temporary directory API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { IntegrationBranch } from "./main.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((one) => rm(one, { recursive: true, force: true })));
});

const NAME = "operator/integration/source";

async function repository(): Promise<string> {
  const root = await mkdtemp(`${tmpdir()}/integration-branch-`);
  roots.push(root);
  await Bun.$`git init -q -b main ${root}`.quiet();
  await write(root, "a.txt", lines("a", 20));
  await write(root, "b.txt", lines("b", 20));
  await commit(root, "base", "2001-01-01T00:00:00Z");
  return root;
}

function lines(prefix: string, count: number, changed: Record<number, string> = {}): string {
  return Array.from({ length: count }, (_, index) => changed[index] ?? `${prefix}${index}`)
    .join("\n")
    .concat("\n");
}

async function write(root: string, path: string, text: string): Promise<void> {
  await Bun.write(`${root}/${path}`, text);
}

async function commit(root: string, message: string, date: string): Promise<string> {
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} -c user.name=Producer -c user.email=producer@example.test -c commit.gpgsign=false commit -q -m ${message}`
    .env({ ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
    .quiet();
  return head(root, "HEAD");
}

/**
 * Runs one call with a Git on the path that fails one subcommand. `term` ends it on SIGTERM, as
 * a timeout does, and `exit` ends it with exit 3. Each one writes `stderr` first.
 */
async function withFailingGit<Value>(
  folder: string,
  fault: { subcommand: string; end: "term" | "exit"; stderr: string },
  run: () => Promise<Value>,
): Promise<Value> {
  const real = Bun.which("git");
  const bin = `${folder}/failing-git`;
  await Bun.write(
    `${bin}/git`,
    [
      "#!/bin/sh",
      // The guard of ADR 0018 and `-C <repo>` come before the subcommand.
      `if [ "$6" = "${fault.subcommand}" ]; then`,
      `  printf '%s' '${fault.stderr}' >&2`,
      fault.end === "term" ? "  kill -TERM $$" : "  exit 3",
      "fi",
      `exec ${real} "$@"`,
      "",
    ].join("\n"),
  );
  await Bun.$`chmod +x ${bin}/git`.quiet();
  const inherited = process.env.PATH ?? "";
  process.env.PATH = `${bin}:${inherited}`;
  try {
    return await run();
  } finally {
    process.env.PATH = inherited;
  }
}

async function head(root: string, ref: string): Promise<string> {
  return (await Bun.$`git -C ${root} rev-parse ${ref}`.text()).trim();
}

/** One reviewed commit on its own branch, made from `start` with one changed file. */
async function result(
  root: string,
  request: { start: string; branch: string; path: string; text: string; date: string },
): Promise<string> {
  await Bun.$`git -C ${root} checkout -q -b ${request.branch} ${request.start}`.quiet();
  await write(root, request.path, request.text);
  const made = await commit(root, `change ${request.path}`, request.date);
  await Bun.$`git -C ${root} checkout -q main`.quiet();
  return made;
}

/** The patch identity of one commit against its parent, with plain Git (ADR 0020). */
async function patchId(root: string, commit: string): Promise<string> {
  const diff =
    await Bun.$`git -C ${root} diff-tree -p --no-renames --unified=3 --binary --full-index --no-color --no-ext-diff --no-textconv ${commit}^ ${commit}`.text();
  const id = await Bun.$`git -C ${root} patch-id --verbatim < ${new Response(diff)}`.text();
  return id.trim().split(" ")[0] ?? "";
}

async function branchAt(root: string, commit: string): Promise<void> {
  await Bun.$`git -C ${root} update-ref refs/heads/${NAME} ${commit}`.quiet();
}

async function land(root: string, request: { base: string; tip: string; commit: string }) {
  const plan = await IntegrationBranch.plan({
    repoRoot: root,
    name: NAME,
    base: request.base,
    recordedTip: request.tip,
    commit: request.commit,
    reviewedBase: `${request.commit}^`,
  });
  if (plan.status !== "ready") {
    throw new Error(`plan refused: ${JSON.stringify(plan)}`);
  }
  const moved = await IntegrationBranch.move({
    repoRoot: root,
    name: NAME,
    from: plan.from,
    to: plan.to,
  });
  expect(moved.status).toBe("moved");
  return plan;
}

describe("IntegrationBranch landing", () => {
  test("a commit on the tip lands as itself, so the Operative commit identity is kept", async () => {
    const root = await repository();
    const base = await head(root, "main");
    await branchAt(root, base);
    const reviewed = await result(root, {
      start: base,
      branch: "work-a",
      path: "a.txt",
      text: lines("a", 20, { 0: "A0" }),
      date: "2002-01-01T00:00:00Z",
    });

    const plan = await land(root, { base, tip: base, commit: reviewed });

    expect(plan).toMatchObject({ kind: "fast-forward", from: base, to: reviewed });
    expect(await head(root, NAME)).toBe(reviewed);
  });

  test("a merge landing makes one new commit with an equal patch, the same on every plan", async () => {
    const root = await repository();
    const base = await head(root, "main");
    const first = await result(root, {
      start: base,
      branch: "work-a",
      path: "a.txt",
      text: lines("a", 20, { 0: "A0" }),
      date: "2002-01-01T00:00:00Z",
    });
    const second = await result(root, {
      start: base,
      branch: "work-b",
      path: "b.txt",
      text: lines("b", 20, { 0: "B0" }),
      date: "2003-01-01T00:00:00Z",
    });
    await branchAt(root, first);

    const request = {
      repoRoot: root,
      name: NAME,
      base,
      recordedTip: first,
      commit: second,
      reviewedBase: base,
    };
    const plan = await IntegrationBranch.plan(request);
    const again = await IntegrationBranch.plan(request);

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    expect(plan.kind).toBe("merge");
    expect(plan.to).not.toBe(second);
    expect(again).toEqual(plan);
    // The landed commit copies the author, the committer, both dates, and the message.
    const shown = (sha: string) =>
      Bun.$`git -C ${root} show -s --format=%an%n%ae%n%ad%n%cn%n%ce%n%cd%n%B --date=raw ${sha}`.text();
    expect(await shown(plan.to)).toBe(await shown(second));
    expect((await Bun.$`git -C ${root} rev-parse ${plan.to}^`.text()).trim()).toBe(first);
    expect(await patchId(root, plan.to)).toBe(plan.patch);
    // Planning moves no ref.
    expect(await head(root, NAME)).toBe(first);
  });

  test("a merge landing of a signed commit makes an unsigned commit", async () => {
    const root = await repository();
    const base = await head(root, "main");
    const first = await result(root, {
      start: base,
      branch: "work-a",
      path: "a.txt",
      text: lines("a", 20, { 0: "A0" }),
      date: "2002-01-01T00:00:00Z",
    });
    const unsigned = await result(root, {
      start: base,
      branch: "work-b",
      path: "b.txt",
      text: lines("b", 20, { 0: "B0" }),
      date: "2003-01-01T00:00:00Z",
    });
    // The signature is not checked, so a header with any value stands in for a real signature.
    const object = await Bun.$`git -C ${root} cat-file commit ${unsigned}`.text();
    const [headers = "", ...message] = object.split("\n\n");
    const signedObject = `${headers}\ngpgsig -----BEGIN PGP SIGNATURE-----\n -----END PGP SIGNATURE-----\n\n${message.join("\n\n")}`;
    const signed = (
      await Bun.$`git -C ${root} hash-object -t commit -w --stdin < ${new Response(signedObject)}`.text()
    ).trim();
    expect(await Bun.$`git -C ${root} cat-file commit ${signed}`.text()).toContain("gpgsig ");
    await branchAt(root, first);

    const plan = await IntegrationBranch.plan({
      repoRoot: root,
      name: NAME,
      base,
      recordedTip: first,
      commit: signed,
      reviewedBase: base,
    });

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    expect(plan.kind).toBe("merge");
    expect(await Bun.$`git -C ${root} cat-file commit ${plan.to}`.text()).not.toContain("gpgsig");
  });

  test("a change near a sibling in the same file changes the patch and lands nothing", async () => {
    const root = await repository();
    const base = await head(root, "main");
    const first = await result(root, {
      start: base,
      branch: "work-a",
      path: "a.txt",
      text: lines("a", 20, { 5: "A5" }),
      date: "2002-01-01T00:00:00Z",
    });
    // Two lines below the sibling, so its context lines differ on the tip.
    const second = await result(root, {
      start: base,
      branch: "work-b",
      path: "a.txt",
      text: lines("a", 20, { 7: "A7" }),
      date: "2003-01-01T00:00:00Z",
    });
    await branchAt(root, first);

    const plan = await IntegrationBranch.plan({
      repoRoot: root,
      name: NAME,
      base,
      recordedTip: first,
      commit: second,
      reviewedBase: base,
    });

    expect(plan.status).toBe("patch-changed");
    expect(await head(root, NAME)).toBe(first);
  });

  test("a conflict names its path, writes no ref, and leaves no worktree state", async () => {
    const root = await repository();
    const base = await head(root, "main");
    const first = await result(root, {
      start: base,
      branch: "work-a",
      path: "a.txt",
      text: lines("a", 20, { 5: "first" }),
      date: "2002-01-01T00:00:00Z",
    });
    const second = await result(root, {
      start: base,
      branch: "work-b",
      path: "a.txt",
      text: lines("a", 20, { 5: "second" }),
      date: "2003-01-01T00:00:00Z",
    });
    await branchAt(root, first);
    const status = await Bun.$`git -C ${root} status --porcelain`.text();

    const plan = await IntegrationBranch.plan({
      repoRoot: root,
      name: NAME,
      base,
      recordedTip: first,
      commit: second,
      reviewedBase: base,
    });

    expect(plan).toEqual({ status: "conflict", paths: ["a.txt"] });
    expect(await head(root, NAME)).toBe(first);
    expect(await Bun.$`git -C ${root} status --porcelain`.text()).toBe(status);
  });

  test("a commit whose equal patch the branch already holds lands nothing", async () => {
    const root = await repository();
    const base = await head(root, "main");
    const other = await result(root, {
      start: base,
      branch: "work-b",
      path: "b.txt",
      text: lines("b", 20, { 0: "B0" }),
      date: "2002-01-01T00:00:00Z",
    });
    const reviewed = await result(root, {
      start: base,
      branch: "work-a",
      path: "a.txt",
      text: lines("a", 20, { 0: "A0" }),
      date: "2003-01-01T00:00:00Z",
    });
    await branchAt(root, other);
    const landed = await land(root, { base, tip: other, commit: reviewed });

    const plan = await IntegrationBranch.plan({
      repoRoot: root,
      name: NAME,
      base,
      recordedTip: landed.to,
      commit: reviewed,
      reviewedBase: base,
    });

    expect(plan).toMatchObject({
      status: "ready",
      kind: "held",
      from: landed.to,
      to: landed.to,
      landed: landed.to,
      landedParent: other,
    });
  });

  test("a plan that reads neither the commit nor the base names the unread commit", async () => {
    const root = await repository();
    const tip = await head(root, "main");
    await branchAt(root, tip);
    const missing = "1111111111111111111111111111111111111111";
    const unknownBase = "2222222222222222222222222222222222222222";

    const plan = await IntegrationBranch.plan({
      repoRoot: root,
      name: NAME,
      base: unknownBase,
      recordedTip: tip,
      commit: missing,
      reviewedBase: tip,
    });

    // The commit is read first, so its Git message is the detail, not the one of the base.
    const read = await Bun.$`git -C ${root} cat-file commit ${missing}`.nothrow().quiet();
    expect(plan).toEqual({ status: "unread", detail: read.stderr.toString().trim() });
  });

  test("a commit on the tip lands as itself when the base cannot be listed", async () => {
    const root = await repository();
    const tip = await head(root, "main");
    await branchAt(root, tip);
    const reviewed = await result(root, {
      start: tip,
      branch: "work-a",
      path: "a.txt",
      text: lines("a", 20, { 0: "A0" }),
      date: "2002-01-01T00:00:00Z",
    });

    const plan = await IntegrationBranch.plan({
      repoRoot: root,
      name: NAME,
      base: "2222222222222222222222222222222222222222",
      recordedTip: tip,
      commit: reviewed,
      reviewedBase: tip,
    });

    expect(plan).toMatchObject({ status: "ready", kind: "fast-forward", to: reviewed });
  });

  test("a move from a tip that is not the branch moves nothing and names the tip it found", async () => {
    const root = await repository();
    const base = await head(root, "main");
    const reviewed = await result(root, {
      start: base,
      branch: "work-a",
      path: "a.txt",
      text: lines("a", 20, { 0: "A0" }),
      date: "2002-01-01T00:00:00Z",
    });
    const person = await result(root, {
      start: base,
      branch: "person",
      path: "b.txt",
      text: lines("b", 20, { 0: "B0" }),
      date: "2003-01-01T00:00:00Z",
    });
    await branchAt(root, person);

    const moved = await IntegrationBranch.move({
      repoRoot: root,
      name: NAME,
      from: base,
      to: reviewed,
    });

    expect(moved).toEqual({ status: "tip-moved", found: person, checkedOut: [] });
    expect(await head(root, NAME)).toBe(person);
  });

  test("a branch that a worktree has checked out is never planned or moved", async () => {
    const root = await repository();
    const base = await head(root, "main");
    const reviewed = await result(root, {
      start: base,
      branch: "work-a",
      path: "a.txt",
      text: lines("a", 20, { 0: "A0" }),
      date: "2002-01-01T00:00:00Z",
    });
    await branchAt(root, base);
    const worktree = `${root}-checkout`;
    roots.push(worktree);
    await Bun.$`git -C ${root} worktree add -q ${worktree} ${NAME}`.quiet();
    const listed = (await Bun.$`git -C ${worktree} rev-parse --show-toplevel`.text()).trim();

    const plan = await IntegrationBranch.plan({
      repoRoot: root,
      name: NAME,
      base,
      recordedTip: base,
      commit: reviewed,
      reviewedBase: base,
    });
    const moved = await IntegrationBranch.move({
      repoRoot: root,
      name: NAME,
      from: base,
      to: reviewed,
    });

    expect(plan).toEqual({ status: "checked-out", worktrees: [listed] });
    expect(moved).toEqual({ status: "checked-out", worktrees: [listed] });
    expect(await head(root, NAME)).toBe(base);
  });

  test("a repeated move after the branch reached the planned commit answers moved", async () => {
    const root = await repository();
    const base = await head(root, "main");
    const reviewed = await result(root, {
      start: base,
      branch: "work-a",
      path: "a.txt",
      text: lines("a", 20, { 0: "A0" }),
      date: "2002-01-01T00:00:00Z",
    });
    await branchAt(root, reviewed);

    const moved = await IntegrationBranch.move({
      repoRoot: root,
      name: NAME,
      from: base,
      to: reviewed,
    });

    expect(moved).toEqual({ status: "moved" });
  });
});

describe("IntegrationBranch rewrite", () => {
  /**
   * Three landed commits: one in a.txt, then two in b.txt far apart. The correction changes
   * a.txt again on top of the first, as a correction dispatch starts at the landed commit.
   */
  async function threeLanded(root: string, later = { path: "b.txt", prefix: "b" }) {
    const base = await head(root, "main");
    await branchAt(root, base);
    const first = await result(root, {
      start: base,
      branch: "work-a",
      path: "a.txt",
      text: lines("a", 20, { 0: "A0" }),
      date: "2002-01-01T00:00:00Z",
    });
    await land(root, { base, tip: base, commit: first });
    const second = await result(root, {
      start: first,
      branch: "work-b",
      path: later.path,
      // In a.txt the change sits near the fix, with no overlap, so it merges as another patch.
      text: lines(later.prefix, 20, later.path === "a.txt" ? { 0: "A0", 4: "X4" } : { 3: "X3" }),
      date: "2003-01-01T00:00:00Z",
    });
    await land(root, { base, tip: first, commit: second });
    const third = await result(root, {
      start: second,
      branch: "work-c",
      path: "b.txt",
      text: lines("b", 20, { 3: later.path === "b.txt" ? "X3" : "b3", 19: "B19" }),
      date: "2004-01-01T00:00:00Z",
    });
    await land(root, { base, tip: second, commit: third });
    const fix = await result(root, {
      start: first,
      branch: "work-fix",
      path: "a.txt",
      text: lines("a", 20, { 0: "A0", 1: "A1" }),
      date: "2005-01-01T00:00:00Z",
    });
    return { base, first, second, third, fix };
  }

  function rewrite(
    root: string,
    request: {
      base: string;
      tip: string;
      replaces: string;
      fix: string;
      reviewedBase: string;
      later: Array<{ commit: string; needs: string[] }>;
      refused?: string[];
      published?: Array<{ head: string; pullRequest: number | null; url: string | null }>;
    },
  ) {
    return IntegrationBranch.rewrite({
      repoRoot: root,
      name: NAME,
      base: request.base,
      recordedTip: request.tip,
      replaces: request.replaces,
      correction: { commit: request.fix, reviewedBase: request.reviewedBase },
      later: request.later,
      refused: request.refused ?? [],
      published: request.published ?? [],
    });
  }

  async function patch(root: string, commit: string): Promise<string> {
    return Bun.$`git -C ${root} diff-tree -p --no-renames ${commit}^ ${commit}`.text();
  }

  test("puts the correction in place, lands each later commit again, and moves no ref", async () => {
    const root = await repository();
    const { base, first, second, third, fix } = await threeLanded(root);
    const later = [
      { commit: second, needs: [] },
      { commit: third, needs: [] },
    ];
    const request = { base, tip: third, replaces: first, fix, reviewedBase: base, later };

    const plan = await rewrite(root, request);

    if (plan.status !== "ready") {
      throw new Error(`rewrite refused: ${JSON.stringify(plan)}`);
    }
    expect(await head(root, NAME)).toBe(third);
    expect(plan).toMatchObject({ from: third, replaced: { commit: first, parent: base } });
    expect(plan.correction?.parent).toBe(base);
    // The correction carries the landed change and the fix as one commit on the old parent.
    expect(await patch(root, plan.correction?.commit ?? "")).toContain("+A1");
    expect(await patch(root, plan.correction?.commit ?? "")).toContain("+A0");
    expect(plan.relanded.map((one) => one.was)).toEqual([second, third]);
    expect(plan.relanded[0]?.parent).toBe(plan.correction?.commit ?? "");
    expect(plan.to).toBe(plan.relanded[1]?.commit ?? "");
    for (const one of plan.relanded) {
      expect(one.commit).not.toBe(one.was);
      expect(await patch(root, one.commit)).toBe(await patch(root, one.was));
    }
    expect(plan.takenOut).toEqual([]);
    // A repeat gives the same commits, so the intent names the exact rebuilt tip.
    expect(await rewrite(root, request)).toEqual(plan);
  });

  test("takes out a later commit whose patch changes, and each later commit that needs it", async () => {
    const root = await repository();
    // The second commit changes a.txt two lines from the fix, so its patch context changes.
    const { base, first, second, third, fix } = await threeLanded(root, {
      path: "a.txt",
      prefix: "a",
    });

    const plan = await rewrite(root, {
      base,
      tip: third,
      replaces: first,
      fix,
      reviewedBase: base,
      later: [
        { commit: second, needs: [] },
        { commit: third, needs: [second] },
      ],
    });

    if (plan.status !== "ready") {
      throw new Error(`rewrite refused: ${JSON.stringify(plan)}`);
    }
    expect(plan.takenOut).toEqual([
      { commit: second, cause: "patch-changed" },
      { commit: third, cause: "dependency" },
    ]);
    expect(plan.relanded).toEqual([]);
    expect(plan.to).toBe(plan.correction?.commit ?? "");
  });

  test("takes out a withdrawn commit with no correction, and drops each other one it names", async () => {
    const root = await repository();
    const { base, first, second, third } = await threeLanded(root);

    const plan = await IntegrationBranch.rewrite({
      repoRoot: root,
      name: NAME,
      base,
      recordedTip: third,
      replaces: first,
      correction: null,
      later: [
        { commit: second, needs: [], drop: true },
        { commit: third, needs: [] },
      ],
      refused: [],
      published: [],
    });

    if (plan.status !== "ready") {
      throw new Error(`take-out refused: ${JSON.stringify(plan)}`);
    }
    expect(await head(root, NAME)).toBe(third);
    expect(plan.correction).toBeNull();
    expect(plan.removed).toEqual([second]);
    // Nothing takes the place of the withdrawn commits, so the later one lands on their parent.
    expect(plan.relanded.map((one) => ({ was: one.was, parent: one.parent }))).toEqual([
      { was: third, parent: base },
    ]);
    expect(plan.to).toBe(plan.relanded[0]?.commit ?? "");
    expect(plan.takenOut).toEqual([]);
  });

  test("takes out a later commit that needs a withdrawn commit", async () => {
    const root = await repository();
    const { base, first, second, third } = await threeLanded(root);

    const plan = await IntegrationBranch.rewrite({
      repoRoot: root,
      name: NAME,
      base,
      recordedTip: third,
      replaces: first,
      correction: null,
      later: [
        { commit: second, needs: [first] },
        { commit: third, needs: [] },
      ],
      refused: [],
      published: [],
    });

    if (plan.status !== "ready") {
      throw new Error(`take-out refused: ${JSON.stringify(plan)}`);
    }
    expect(plan.takenOut).toEqual([{ commit: second, cause: "dependency" }]);
    expect(plan.relanded.map((one) => one.was)).toEqual([third]);
  });

  test("takes out a later commit whose new tree the gate refused, and keeps the rest", async () => {
    const root = await repository();
    const { base, first, second, third, fix } = await threeLanded(root);
    const later = [
      { commit: second, needs: [] },
      { commit: third, needs: [] },
    ];
    const request = { base, tip: third, replaces: first, fix, reviewedBase: base, later };
    const planned = await rewrite(root, request);
    if (planned.status !== "ready") {
      throw new Error("rewrite refused");
    }

    const plan = await rewrite(root, { ...request, refused: [planned.relanded[0]?.tree ?? ""] });

    if (plan.status !== "ready") {
      throw new Error(`rewrite refused: ${JSON.stringify(plan)}`);
    }
    expect(plan.takenOut).toEqual([{ commit: second, cause: "gate" }]);
    expect(plan.relanded.map((one) => one.was)).toEqual([third]);
    expect(plan.relanded[0]?.parent).toBe(plan.correction?.commit ?? "");
  });

  test("refuses a replaced commit inside a published range and names its pull request", async () => {
    const root = await repository();
    const { base, first, second, third, fix } = await threeLanded(root);
    const later = [
      { commit: second, needs: [] },
      { commit: third, needs: [] },
    ];
    const request = { base, tip: third, replaces: first, fix, reviewedBase: base, later };
    const url = "https://github.com/o/r/pull/7";

    const refused = await rewrite(root, {
      ...request,
      published: [{ head: second, pullRequest: 7, url }],
    });

    expect(refused).toEqual({ status: "published-range", pullRequest: 7, url });
    // A commit that landed after the last publish is rewritten locally.
    const local = await rewrite(root, {
      ...request,
      replaces: second,
      later: [{ commit: third, needs: [] }],
      reviewedBase: first,
      published: [{ head: first, pullRequest: 7, url }],
    });
    expect(local.status).toBe("ready");
  });

  test("refuses a record that the branch does not hold in the same order", async () => {
    const root = await repository();
    const { base, first, second, third, fix } = await threeLanded(root);

    const plan = await rewrite(root, {
      base,
      tip: third,
      replaces: first,
      fix,
      reviewedBase: base,
      later: [{ commit: second, needs: [] }],
    });

    expect(plan.status).toBe("unread");
    expect(await head(root, NAME)).toBe(third);
  });
});

describe("IntegrationBranch rebase", () => {
  /** Two landed commits: one in a.txt, then one in b.txt, on the base of main. */
  async function twoLanded(root: string) {
    const base = await head(root, "main");
    await branchAt(root, base);
    const first = await result(root, {
      start: base,
      branch: "work-a",
      path: "a.txt",
      text: lines("a", 20, { 0: "A0" }),
      date: "2002-01-01T00:00:00Z",
    });
    await land(root, { base, tip: base, commit: first });
    const second = await result(root, {
      start: first,
      branch: "work-b",
      path: "b.txt",
      text: lines("b", 20, { 10: "B10" }),
      date: "2003-01-01T00:00:00Z",
    });
    await land(root, { base, tip: first, commit: second });
    return { base, first, second };
  }

  /** One commit on main, as a merge of another source moves the target. */
  async function moveMain(root: string, path: string, text: string): Promise<string> {
    await write(root, path, text);
    return commit(root, `upstream ${path}`, "2006-01-01T00:00:00Z");
  }

  function rebase(
    root: string,
    request: {
      base: string;
      tip: string;
      newBase: string;
      commits: Array<{ commit: string; needs?: string[]; merged?: boolean }>;
      mergeCommits?: string[];
      refused?: string[];
    },
  ) {
    return IntegrationBranch.rebase({
      repoRoot: root,
      name: NAME,
      base: request.base,
      recordedTip: request.tip,
      newBase: request.newBase,
      commits: request.commits.map((one) => ({
        commit: one.commit,
        needs: one.needs ?? [],
        merged: one.merged ?? false,
      })),
      mergeCommits: request.mergeCommits ?? [],
      refused: request.refused ?? [],
    });
  }

  async function patch(root: string, commit: string): Promise<string> {
    return Bun.$`git -C ${root} diff-tree -p --no-renames ${commit}^ ${commit}`.text();
  }

  test("lands each commit again on the new base with an equal patch, and moves no ref", async () => {
    const root = await repository();
    const { base, first, second } = await twoLanded(root);
    const newBase = await moveMain(root, "c.txt", "upstream\n");

    const plan = await rebase(root, {
      base,
      tip: second,
      newBase,
      commits: [{ commit: first }, { commit: second }],
    });

    if (plan.status !== "ready") {
      throw new Error(`rebase refused: ${JSON.stringify(plan)}`);
    }
    expect(plan.base).toEqual({
      from: base,
      to: newBase,
      tree: (await Bun.$`git -C ${root} rev-parse ${`${newBase}^{tree}`}`.text()).trim(),
    });
    expect(plan.takenOut).toEqual([]);
    expect(plan.merged).toEqual([]);
    expect(plan.relanded.map((one) => one.was)).toEqual([first, second]);
    expect(plan.relanded[0]?.parent).toBe(newBase);
    expect(plan.relanded[1]?.parent).toBe(plan.relanded[0]?.commit ?? "");
    expect(plan.to).toBe(plan.relanded[1]?.commit ?? "");
    expect(await patch(root, plan.to)).toBe(await patch(root, second));
    // The plan writes only Git objects. The branch moves only through `move`.
    expect(await head(root, NAME)).toBe(second);
  });

  test("takes out a commit whose patch changes on the new base, and each commit that needs it", async () => {
    const root = await repository();
    const { base, first, second } = await twoLanded(root);
    // A change two lines from the first result merges cleanly but changes its context lines.
    const newBase = await moveMain(root, "a.txt", lines("a", 20, { 2: "U2" }));

    const plan = await rebase(root, {
      base,
      tip: second,
      newBase,
      commits: [{ commit: first }, { commit: second, needs: [first] }],
    });

    if (plan.status !== "ready") {
      throw new Error(`rebase refused: ${JSON.stringify(plan)}`);
    }
    expect(plan.takenOut).toEqual([
      { commit: first, cause: "patch-changed" },
      { commit: second, cause: "dependency" },
    ]);
    expect(plan.relanded).toEqual([]);
    expect(plan.to).toBe(newBase);
  });

  test("a commit whose pull request merged leaves the branch, and its merge commit must be in the new base", async () => {
    const root = await repository();
    const { base, first, second } = await twoLanded(root);
    await Bun.$`git -C ${root} -c user.name=Person -c user.email=person@example.test merge -q --no-ff -m merge ${first}`.quiet();
    const merge = await head(root, "main");
    const commits = [{ commit: first, merged: true }, { commit: second }];

    const plan = await rebase(root, {
      base,
      tip: second,
      newBase: merge,
      commits,
      mergeCommits: [merge],
    });

    if (plan.status !== "ready") {
      throw new Error(`rebase refused: ${JSON.stringify(plan)}`);
    }
    expect(plan.merged).toEqual([first]);
    expect(plan.relanded.map((one) => one.was)).toEqual([second]);
    expect(plan.relanded[0]?.parent).toBe(merge);
    expect(await patch(root, plan.to)).toBe(await patch(root, second));

    // A new base that does not hold the merge would drop a commit the target never received.
    await Bun.$`git -C ${root} checkout -q -b other ${base}`.quiet();
    const without = await moveMain(root, "d.txt", "other\n");
    await Bun.$`git -C ${root} checkout -q main`.quiet();
    const refused = await rebase(root, {
      base,
      tip: second,
      newBase: without,
      commits,
      mergeCommits: [merge],
    });
    expect(refused).toEqual({ status: "merge-not-in-base", mergeCommit: merge, newBase: without });
  });

  test("refuses a new base that is the old base or not ahead of it", async () => {
    const root = await repository();
    const { base, first, second } = await twoLanded(root);
    const commits = [{ commit: first }, { commit: second }];

    expect(await rebase(root, { base, tip: second, newBase: base, commits })).toEqual({
      status: "base-unchanged",
    });
    await Bun.$`git -C ${root} checkout -q --orphan unrelated`.quiet();
    const unrelated = await moveMain(root, "e.txt", "unrelated\n");
    await Bun.$`git -C ${root} checkout -q -f main`.quiet();
    expect(await rebase(root, { base, tip: second, newBase: unrelated, commits })).toEqual({
      status: "base-not-ahead",
      base,
      newBase: unrelated,
    });
    // A record that leaves out a commit of the branch moves nothing.
    const short = await rebase(root, { base, tip: second, newBase: unrelated, commits: [] });
    expect(short.status).toBe("unread");
  });
});

describe("IntegrationBranch holds", () => {
  /** A branch with two landed commits, so the first one is held below the tip. */
  async function landedTwice(root: string) {
    const base = await head(root, "main");
    await branchAt(root, base);
    const first = await result(root, {
      start: base,
      branch: "work-a",
      path: "a.txt",
      text: lines("a", 20, { 0: "A0" }),
      date: "2002-01-01T00:00:00Z",
    });
    await land(root, { base, tip: base, commit: first });
    const second = await result(root, {
      start: base,
      branch: "work-b",
      path: "b.txt",
      text: lines("b", 20, { 0: "B0" }),
      date: "2003-01-01T00:00:00Z",
    });
    const merged = await land(root, { base, tip: first, commit: second });
    return { base, first, second, tip: merged.to };
  }

  test("a commit below the recorded tip is held, and a merge landing holds its new commit", async () => {
    const root = await repository();
    const { first, second, tip } = await landedTwice(root);
    const holds = (commit: string) =>
      IntegrationBranch.holds({ repoRoot: root, name: NAME, recordedTip: tip, commit });

    expect(await holds(first)).toEqual({ status: "held" });
    expect(await holds(tip)).toEqual({ status: "held" });
    // The reviewed commit of a merge landing is not the commit that carries it.
    expect(await holds(second)).toEqual({ status: "not-held" });
  });

  test("a branch away from its recorded tip moved, even when it still holds the commit", async () => {
    const root = await repository();
    const { first, tip } = await landedTwice(root);
    await Bun.$`git -C ${root} commit -q --allow-empty -m person`.quiet();
    const person = await head(root, "main");
    await branchAt(root, person);

    expect(
      await IntegrationBranch.holds({
        repoRoot: root,
        name: NAME,
        recordedTip: tip,
        commit: first,
      }),
    ).toEqual({ status: "tip-moved", found: person });
  });

  test("a deleted branch is missing, and nothing falls back to another ref", async () => {
    const root = await repository();
    const { first, tip } = await landedTwice(root);
    await Bun.$`git -C ${root} update-ref refs/heads/main ${tip}`.quiet();
    await Bun.$`git -C ${root} update-ref -d refs/heads/${NAME}`.quiet();

    expect(
      await IntegrationBranch.holds({
        repoRoot: root,
        name: NAME,
        recordedTip: tip,
        commit: first,
      }),
    ).toEqual({ status: "missing" });
  });
});

describe("IntegrationBranch interdiff", () => {
  test("gives the reviewed patch and only the change between it and the new patch", async () => {
    const root = await repository();
    const base = await head(root, "main");
    const reviewed = await result(root, {
      start: base,
      branch: "work-a",
      path: "a.txt",
      text: lines("a", 20, { 5: "A5" }),
      date: "2002-01-01T00:00:00Z",
    });
    // A near line changed on the tip, so the same change made again carries another patch.
    const tip = await result(root, {
      start: base,
      branch: "work-b",
      path: "a.txt",
      text: lines("a", 20, { 3: "A3" }),
      date: "2003-01-01T00:00:00Z",
    });
    const combined = await result(root, {
      start: tip,
      branch: "work-c",
      path: "a.txt",
      text: lines("a", 20, { 3: "A3", 5: "A5" }),
      date: "2004-01-01T00:00:00Z",
    });

    const read = await IntegrationBranch.interdiff({ repoRoot: root, reviewed, current: combined });

    expect(read.status).toBe("read");
    if (read.status !== "read") return;
    expect(read.reviewedPatch).toBe(
      await Bun.$`git -C ${root} diff-tree -p --no-renames --full-index ${reviewed}^ ${reviewed}`.text(),
    );
    expect(read.interdiff).toContain("- a3");
    expect(read.interdiff).toContain("+ A3");
    expect(read.interdiff).not.toContain("+-a5");
  });

  test("an equal patch gives an empty interdiff", async () => {
    const root = await repository();
    const base = await head(root, "main");
    const change = { path: "a.txt", text: lines("a", 20, { 0: "A0" }) };
    const reviewed = await result(root, {
      start: base,
      branch: "work-a",
      ...change,
      date: "2002-01-01T00:00:00Z",
    });
    const tip = await result(root, {
      start: base,
      branch: "work-b",
      path: "b.txt",
      text: lines("b", 20, { 0: "B0" }),
      date: "2003-01-01T00:00:00Z",
    });
    const again = await result(root, {
      start: tip,
      branch: "work-c",
      ...change,
      date: "2004-01-01T00:00:00Z",
    });

    const read = await IntegrationBranch.interdiff({ repoRoot: root, reviewed, current: again });

    expect(read).toMatchObject({ status: "read", interdiff: "" });
  });
});

describe("IntegrationBranch Git failures", () => {
  test("words a Git timeout and a Git exit as before", async () => {
    const root = await repository();
    const tip = await head(root, "HEAD");
    const request = { repoRoot: root, name: NAME, recordedTip: tip };

    const timedOut = await withFailingGit(
      root,
      { subcommand: "rev-parse", end: "term", stderr: "stuck" },
      () => IntegrationBranch.read(request),
    );
    const exited = await withFailingGit(
      root,
      { subcommand: "worktree", end: "exit", stderr: "boom" },
      () => IntegrationBranch.read(request),
    );

    expect(timedOut).toEqual({
      status: "unread",
      detail: "git -C ended on SIGTERM with no answer.",
    });
    expect(exited).toEqual({ status: "unread", detail: "git worktree exited 3: boom" });
  });
});
