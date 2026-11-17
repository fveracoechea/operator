import { expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { stackGit, stackCandidate, stackCommit } from "./stack-git.ts";

test("candidate construction preserves only the old-cut child delta and never installs conflicting trees", async () => {
  const cwd = await mkdtemp("/tmp/opencode/stack-git-");
  try {
    async function git(...args: string[]) {
      const result = await stackGit(cwd, args);
      expect(result.ok, result.detail).toBe(true);
      return result.out;
    }
    await git("init", "-q", "-b", "main");
    await git("config", "user.name", "Fixture");
    await git("config", "user.email", "fixture@example.com");
    await Bun.write(`${cwd}/base`, "base\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    const root = await git("rev-parse", "HEAD");
    await Bun.write(`${cwd}/obsolete`, "old parent\n");
    await git("add", ".");
    await git("commit", "-qm", "old parent");
    const cut = await git("rev-parse", "HEAD");
    await Bun.write(`${cwd}/child`, "child\n");
    await git("add", ".");
    await git("commit", "-qm", "child");
    const head = await git("rev-parse", "HEAD");
    const candidate = await stackCandidate(cwd, cut, root, head);
    expect(candidate.ok).toBe(true);
    expect(await git("ls-tree", "--name-only", candidate.out)).toBe("base\nchild");
    expect(await git("show", `${candidate.out}:child`)).toBe("child");
    expect(await git("rev-parse", `${candidate.out}^`)).toBe(root);
    expect(await git("rev-parse", "HEAD")).toBe(head);
    expect(await git("status", "--porcelain")).toBe("");
    const again = await stackCandidate(cwd, cut, root, head);
    expect(again).toEqual(candidate);
    const tree = await git("rev-parse", `${head}^{tree}`);
    expect((await stackCommit(cwd, tree, [root], "fixture")).ok).toBe(true);
    expect((await stackCandidate(cwd, "missing-cut", root, head)).ok).toBe(false);
    expect(await git("rev-parse", "HEAD")).toBe(head);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
