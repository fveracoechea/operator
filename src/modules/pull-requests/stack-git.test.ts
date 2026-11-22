import { expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
// Bun has no temporary-directory location API.
import { tmpdir } from "node:os";
import { stackGit, stackCandidate, stackCommit } from "./stack-git.ts";

test("candidate construction preserves only the old-cut child delta and never installs conflicting trees", async () => {
  const cwd = await mkdtemp(`${tmpdir()}/stack-git-`);
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
    await Bun.write(`${cwd}/delete-me`, "delete this inherited file\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    const root = await git("rev-parse", "HEAD");
    await Bun.write(`${cwd}/obsolete`, "old parent\n");
    await git("add", ".");
    await git("commit", "-qm", "old parent");
    const cut = await git("rev-parse", "HEAD");
    await Bun.write(`${cwd}/child`, "child\n");
    await Bun.write(`${cwd}/base`, "child changes inherited bytes\n");
    await Bun.file(`${cwd}/delete-me`).delete();
    const bytes = new Uint8Array([0, 255, 10, 13, 0]);
    await Bun.write(`${cwd}/binary`, bytes);
    await git("add", ".");
    await git("commit", "-qm", "child");
    const head = await git("rev-parse", "HEAD");
    const candidate = await stackCandidate(cwd, cut, root, head);
    expect(candidate.ok).toBe(true);
    expect(await git("ls-tree", "--name-only", candidate.out)).toBe("base\nbinary\nchild");
    expect(await git("show", `${candidate.out}:base`)).toBe("child changes inherited bytes");
    expect(await git("show", `${cut}:delete-me`)).toBe("delete this inherited file");
    const object = Bun.spawn(["git", "show", `${candidate.out}:binary`], { cwd, stdout: "pipe" });
    expect(new Uint8Array(await new Response(object.stdout).arrayBuffer())).toEqual(bytes);
    expect(await object.exited).toBe(0);
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
