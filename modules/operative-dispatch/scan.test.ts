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

test("the inspection and the scan word a Git timeout and a Git exit as before", async () => {
  const { root, repo, worktree } = await checkout();
  const base = (await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim();
  const inspect = () =>
    OperativeDispatch.inspectCheckout({
      worktreePath: worktree,
      baseCommit: base,
      agentHost: "opencode",
    });

  const silent = await withFailingGit(
    root,
    { subcommand: "status", end: "term", stderr: "" },
    inspect,
  );
  const stuck = await withFailingGit(
    root,
    { subcommand: "status", end: "term", stderr: "stuck" },
    inspect,
  );
  const exited = await withFailingGit(
    root,
    { subcommand: "status", end: "exit", stderr: "boom" },
    inspect,
  );
  const scan = await withFailingGit(root, { subcommand: "worktree", end: "term", stderr: "" }, () =>
    OperativeDispatch.scanOutside({ projectRoot: repo, worktreePath: worktree }),
  );

  // Bun reports a child that SIGTERM ended with exit 143.
  expect(silent.uncommitted).toEqual({ status: "unread", detail: "git status failed: exit 143" });
  expect(stuck.uncommitted).toEqual({ status: "unread", detail: "git status failed: stuck" });
  expect(exited.uncommitted).toEqual({ status: "unread", detail: "git status failed: boom" });
  expect(scan.parent).toEqual({ status: "unread", detail: "git worktree failed: exit 143" });
});

test("a Git that is not on the path is a scan that could not run", async () => {
  const { root, repo, worktree } = await checkout();
  const inherited = process.env.PATH ?? "";
  process.env.PATH = join(root, "empty");
  try {
    const scan = await OperativeDispatch.scanOutside({ projectRoot: repo, worktreePath: worktree });

    const unread = {
      status: "unread",
      detail: "git is not on the path, so nothing was requested.",
    } satisfies { status: "unread"; detail: string };
    expect(scan).toEqual({ parent: unread, checkout: unread });
  } finally {
    process.env.PATH = inherited;
  }
});
