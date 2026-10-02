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
