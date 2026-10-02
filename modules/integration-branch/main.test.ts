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
    const patch = await IntegrationBranch.patchOf({ repoRoot: root, commit: plan.to });
    expect(patch).toEqual({ status: "read", patch: plan.patch });
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
