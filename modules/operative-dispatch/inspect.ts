import { ContentIdentity } from "../content-identity/main.ts";

export type WorkInspection = {
  worktreePath: string;
  present: boolean;
  branch: string | null;
  head: string | null;
  uncommitted: string[];
  commits: string[];
  identity: string;
};

async function git(worktreePath: string, args: string[]): Promise<string | null> {
  const reading = await read(worktreePath, args);
  return reading.status === "read" ? reading.value : null;
}

function lines(output: string | null): string[] {
  return output === null
    ? []
    : output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

/**
 * Reads the partial work one attempt left in its checkout.
 * A replacement states the identity of the inspection it read, so a checkout that changed
 * between the reading and the decision cannot pass as inspected.
 */
export async function inspectWork(request: {
  worktreePath: string;
  baseCommit: string;
}): Promise<WorkInspection> {
  const head = await git(request.worktreePath, ["rev-parse", "HEAD"]);
  if (head === null) {
    const absent = {
      worktreePath: request.worktreePath,
      present: false,
      branch: null,
      head: null,
      uncommitted: [],
      commits: [],
    };
    return { ...absent, identity: ContentIdentity.of(absent) };
  }

  const [branch, status, log] = await Promise.all([
    git(request.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(request.worktreePath, ["status", "--porcelain"]),
    git(request.worktreePath, ["log", "--format=%H", `${request.baseCommit}..HEAD`]),
  ]);

  const inspection = {
    worktreePath: request.worktreePath,
    present: true,
    branch: branch === null ? null : branch.trim(),
    head: head.trim(),
    uncommitted: lines(status),
    commits: lines(log),
  };

  return { ...inspection, identity: ContentIdentity.of(inspection) };
}

/** One Git reading of a checkout, or why it could not be made. */
export type Reading<Value> =
  | { status: "read"; value: Value }
  | { status: "unread"; detail: string };

export type CheckoutInspection = {
  // Each commit since the base, newest first, with the parents Git records for it.
  commits: Reading<Array<{ commit: string; parents: string[] }>>;
  // Every file the commits since the base add, change, or delete. A rename names both paths.
  changedFiles: Reading<string[]>;
  // Every file Git shows as not committed, outside the paths that Operator wrote.
  uncommitted: Reading<string[]>;
};

async function read(worktreePath: string, args: string[]): Promise<Reading<string>> {
  const child = Bun.spawn(["git", "-C", worktreePath, ...args], {
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

function mapped<Value>(reading: Reading<string>, map: (output: string) => Value): Reading<Value> {
  return reading.status === "read" ? { status: "read", value: map(reading.value) } : reading;
}

/** NUL-separated output keeps a path with a space, a quote, or a newline whole. */
function fields(output: string): string[] {
  return output.split("\0").filter((one) => one.length > 0);
}

/**
 * Reads what one checkout holds since its base, as the one inspection every check of a result
 * or a review report reads. Rename detection is off, because its answer depends on the file
 * content and it hides the old path of a rename, which is a write too (ADR 0018).
 */
export async function inspectCheckout(request: {
  worktreePath: string;
  baseCommit: string;
  writtenPrefixes: string[];
}): Promise<CheckoutInspection> {
  const range = `${request.baseCommit}..HEAD`;
  const [log, diff, status] = await Promise.all([
    read(request.worktreePath, ["log", "--format=%H %P", range]),
    read(request.worktreePath, [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      request.baseCommit,
      "HEAD",
    ]),
    // Every untracked file is listed on its own, so a collapsed directory cannot hide an edit.
    read(request.worktreePath, ["status", "--porcelain=v1", "-z", "--no-renames", "-uall"]),
  ]);

  return {
    commits: mapped(log, (output) =>
      lines(output).map((line) => {
        const [commit = "", ...parents] = line.split(" ");
        return { commit, parents };
      }),
    ),
    changedFiles: mapped(diff, fields),
    uncommitted: mapped(status, (output) =>
      fields(output)
        .map((entry) => entry.slice(3))
        .filter((path) => !request.writtenPrefixes.some((prefix) => path.startsWith(prefix)))
        .toSorted(),
    ),
  };
}
