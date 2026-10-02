// Bun has no directory listing, no lstat, and no real-path API.
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ContentIdentity } from "../content-identity/main.ts";
import type { Reading } from "./inspect.ts";

/** Where one scanned entry lives. Each place is read on its own and can fail on its own. */
export type OutsidePlace = "worktree-parent" | "checkout" | "git-hooks" | "git-config";

/** One entry of a scan. Two scans differ on an entry when its state differs. */
export type OutsideEntry = { place: OutsidePlace; path: string; state: string };

/**
 * The two snapshots of ADR 0018 around one Operative worktree.
 * The folder that holds the worktree and the controlling checkout are read apart, so a part
 * that could not be read never hides what the other part found.
 */
export type OutsideScan = {
  parent: Reading<OutsideEntry[]>;
  checkout: Reading<OutsideEntry[]>;
};

/**
 * Runs one read-only Git command. The checkout config can name a command that Git runs, and a
 * planted one waits for the person, so the scan turns off the file system monitor. It takes no
 * optional lock, so it never writes the index of the checkout either.
 */
async function git(cwd: string, args: string[]): Promise<Reading<string>> {
  const guarded = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", cwd];
  const child = Bun.spawn(["git", ...guarded, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return exitCode === 0
    ? { status: "read", value: stdout }
    : { status: "unread", detail: `git ${args[0]} failed: ${stderr.trim() || `exit ${exitCode}`}` };
}

/** The real path, or the path itself when it is gone, so a removed worktree still compares. */
async function real(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The state of one entry: a file by its size and modification time, a folder only by presence. */
async function stateOf(path: string): Promise<string> {
  const found = await lstat(path);
  if (found.isDirectory()) {
    return "folder";
  }
  if (found.isSymbolicLink()) {
    return `link to ${await readlink(path)}`;
  }
  if (found.isFile()) {
    return `file of ${found.size} bytes modified ${found.mtime.toISOString()}`;
  }
  return "other";
}

/**
 * The folder that holds the worktree, one level deep.
 * A folder modification time moves when the user edits files in other projects, so a folder
 * counts only by presence, and nothing below this one level is read.
 */
async function scanParent(worktreePath: string, worktrees: string[]): Promise<OutsideEntry[]> {
  const folder = await real(dirname(resolve(worktreePath)));
  // Each host writes its home folder during every run, so no home folder is read at all.
  const home = Bun.env.HOME;
  if (home !== undefined && folder === (await real(home))) {
    throw new Error(`the worktree folder ${folder} is the home folder, which Operator never reads`);
  }

  const skipped = new Set(worktrees.filter((path) => dirname(path) === folder));
  const names = (await readdir(folder)).toSorted();
  const entries: OutsideEntry[] = [];
  for (const name of names) {
    const path = join(folder, name);
    if (!skipped.has(path)) {
      entries.push({ place: "worktree-parent", path, state: await stateOf(path) });
    }
  }
  return entries;
}

/** The identity of one file's bytes, or `absent`. */
async function identityOf(path: string): Promise<string> {
  const file = Bun.file(path);
  return (await file.exists())
    ? ContentIdentity.ofBytes(new Uint8Array(await file.arrayBuffer()))
    : "absent";
}

/**
 * The controlling checkout: what Git shows as not committed outside `.operator/`, and the
 * content of the hooks and the config, which can run a command the next time Git runs.
 */
async function scanCheckout(projectRoot: string, worktrees: string[]): Promise<OutsideEntry[]> {
  const root = await real(projectRoot);
  const [status, common] = await Promise.all([
    git(root, ["status", "--porcelain=v1", "-z", "--no-renames", "-uall"]),
    git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  ]);
  if (status.status === "unread") {
    throw new Error(status.detail);
  }
  if (common.status === "unread") {
    throw new Error(common.detail);
  }

  // A worktree inside the checkout is another Operative's work, never a change to the checkout.
  const nested = worktrees
    .filter((path) => path !== root && path.startsWith(`${root}/`))
    .map((path) => `${relative(root, path)}/`);
  const entries: OutsideEntry[] = status.value
    .split("\0")
    .filter((one) => one.length > 3)
    .map((one) => ({ code: one.slice(0, 2), path: one.slice(3) }))
    .filter(
      (one) =>
        !one.path.startsWith(".operator/") &&
        !nested.some((prefix) => `${one.path}/`.startsWith(prefix)),
    )
    .map((one) => ({ place: "checkout", path: join(root, one.path), state: `git ${one.code}` }));

  const gitDir = common.value.trim();
  const hooks = join(isAbsolute(gitDir) ? gitDir : join(root, gitDir), "hooks");
  let names: string[] = [];
  try {
    names = (await readdir(hooks)).toSorted();
  } catch {
    // A checkout with no hooks folder holds no hook, and a hook added later is still found.
  }
  for (const name of names) {
    const path = join(hooks, name);
    const state = await stateOf(path);
    entries.push({
      place: "git-hooks",
      path,
      state: state.startsWith("file") ? `file ${await identityOf(path)}` : state,
    });
  }

  const config = join(dirname(hooks), "config");
  entries.push({ place: "git-config", path: config, state: await identityOf(config) });
  return entries;
}

async function part(read: () => Promise<OutsideEntry[]>): Promise<Reading<OutsideEntry[]>> {
  try {
    return { status: "read", value: await read() };
  } catch (error) {
    return { status: "unread", detail: failure(error) };
  }
}

/**
 * Scans what lies around one Operative worktree, as one of the two snapshots of an attempt.
 * Every checkout that `git worktree list` names is left out, so the work of other Operatives
 * never reads as a change, and there is no recursive walk.
 */
export async function scanOutside(request: {
  projectRoot: string;
  worktreePath: string;
}): Promise<OutsideScan> {
  const listed = await git(request.projectRoot, ["worktree", "list", "--porcelain"]);
  if (listed.status === "unread") {
    return { parent: listed, checkout: listed };
  }

  const worktrees = await Promise.all(
    listed.value
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => real(line.slice("worktree ".length))),
  );
  const [parent, checkout] = await Promise.all([
    part(() => scanParent(request.worktreePath, worktrees)),
    part(() => scanCheckout(request.projectRoot, worktrees)),
  ]);
  return { parent, checkout };
}
