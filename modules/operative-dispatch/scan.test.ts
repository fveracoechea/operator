import { afterEach, expect, test } from "bun:test";
// Bun has no temporary folder API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperativeDispatch } from "./main.ts";

const folders: string[] = [];

afterEach(async () => {
  await Promise.all(folders.splice(0).map((one) => rm(one, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[]): Promise<void> {
  await Bun.$`git -C ${cwd} -c user.email=t@example.com -c user.name=Test ${args}`.quiet();
}

/** A controlling checkout with one commit, and one Operative worktree next to it. */
async function checkout() {
  const root = await mkdtemp(join(tmpdir(), "operator-scan-"));
  folders.push(root);
  const repo = join(root, "repo");
  await Bun.write(join(repo, "README.md"), "# Project\n");
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-q", "-m", "seed"]);
  const worktree = join(root, "operative");
  await git(repo, ["worktree", "add", "-q", "-b", "operative", worktree]);
  return { root, repo, worktree };
}

test("the scan never runs a core.fsmonitor command that the checkout config names", async () => {
  const { root, repo, worktree } = await checkout();
  const marker = join(root, "fsmonitor-ran");
  const command = join(root, "fsmonitor.sh");
  await Bun.write(command, `#!/bin/sh\ntouch ${marker}\n`);
  await Bun.$`chmod +x ${command}`.quiet();
  await git(repo, ["config", "core.fsmonitor", command]);

  const scan = await OperativeDispatch.scanOutside({ projectRoot: repo, worktreePath: worktree });

  expect(scan.checkout.status).toBe("read");
  // The person decides on a planted command before it runs, so the scan never runs it.
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("a worktree inside the checkout and the files in it are no outside change", async () => {
  const { repo, worktree } = await checkout();
  const nested = join(repo, "nested");
  await git(repo, ["worktree", "add", "-q", "-b", "nested", nested]);
  await Bun.write(join(nested, "work.txt"), "another Operative's work\n");

  const scan = await OperativeDispatch.scanOutside({ projectRoot: repo, worktreePath: worktree });

  expect(scan.checkout.status).toBe("read");
  const found = scan.checkout.status === "read" ? scan.checkout.value : [];
  expect(found.filter((one) => one.place === "checkout")).toEqual([]);
});
