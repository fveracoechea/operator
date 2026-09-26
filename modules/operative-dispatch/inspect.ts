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
  const child = Bun.spawn(["git", "-C", worktreePath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return exitCode === 0 ? stdout : null;
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

export type ReviewWorktreeInspection = {
  present: boolean;
  commits: string[];
  changes: string[];
};

/** Splits one porcelain line into its status and the path it names, rename targets included. */
function changedPath(line: string): string {
  const path = line.replace(/^\S+\s+/, "");
  const renamed = path.split(" -> ");
  return renamed[renamed.length - 1] ?? path;
}

/**
 * Reads what a reviewer changed in its own checkout.
 * A launch writes its own inputs there, so those paths are excluded and whatever remains is
 * the reviewer's own edit. A review may read and run checks; it may never change the work.
 */
export async function inspectReviewWork(request: {
  worktreePath: string;
  baseCommit: string;
  allowedPrefixes: string[];
}): Promise<ReviewWorktreeInspection> {
  const head = await git(request.worktreePath, ["rev-parse", "HEAD"]);
  if (head === null) {
    return { present: false, commits: [], changes: [] };
  }

  const [status, log] = await Promise.all([
    // Every untracked file is listed on its own, so a collapsed directory cannot hide an edit.
    git(request.worktreePath, ["status", "--porcelain", "-uall"]),
    git(request.worktreePath, ["log", "--format=%H", `${request.baseCommit}..HEAD`]),
  ]);

  return {
    present: true,
    commits: lines(log),
    changes: lines(status)
      .map(changedPath)
      .filter((path) => !request.allowedPrefixes.some((prefix) => path.startsWith(prefix))),
  };
}
