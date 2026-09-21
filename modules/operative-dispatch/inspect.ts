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
