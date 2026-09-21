import { ContentIdentity } from "../content-identity/main.ts";

export type CheckoutInspection = {
  worktreePath: string;
  present: boolean;
  branch: string | null;
  head: string | null;
  /** Changed or untracked paths that Operator did not write. */
  unexpectedWork: string[];
  /** Ignored paths that Operator did not write, which no status listing shows by default. */
  unknownIgnored: string[];
  commits: string[];
  /** Commits this branch holds that no remote-tracking reference contains. */
  unpushed: string[];
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

/** Splits one porcelain line into its status and the path it names, rename targets included. */
function changedPath(line: string): { status: string; path: string } {
  const status = line.slice(0, 2).trim();
  const path = line.replace(/^\S+\s+/, "");
  const renamed = path.split(" -> ");
  return { status, path: renamed[renamed.length - 1] ?? path };
}

/** The commits of this branch that no remote-tracking reference holds. */
async function unpushedCommits(worktreePath: string, commits: string[]): Promise<string[]> {
  const checked = await Promise.all(
    commits.map(async (commit) => {
      const containing = lines(
        await git(worktreePath, ["branch", "--remotes", "--contains", commit]),
      );
      return containing.length === 0 ? [commit] : [];
    }),
  );
  return checked.flat();
}

/**
 * Reads one Operative checkout as a disposal decision needs it.
 * Operator writes its own inputs and skills here, so those paths are excluded and whatever
 * remains is work this crew never placed. Ignored files are read as well, because a default
 * status listing hides exactly the files a cleanup must not discard in silence.
 */
export async function inspectCheckout(request: {
  worktreePath: string;
  baseCommit: string;
  allowedPrefixes: string[];
}): Promise<CheckoutInspection> {
  const head = await git(request.worktreePath, ["rev-parse", "HEAD"]);
  if (head === null) {
    const absent = {
      worktreePath: request.worktreePath,
      present: false,
      branch: null,
      head: null,
      unexpectedWork: [],
      unknownIgnored: [],
      commits: [],
      unpushed: [],
    };
    return { ...absent, identity: ContentIdentity.of(absent) };
  }

  const [branch, status, log] = await Promise.all([
    git(request.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    // Every untracked and ignored path is listed on its own, so a collapsed directory hides nothing.
    git(request.worktreePath, ["status", "--porcelain", "-uall", "--ignored"]),
    git(request.worktreePath, ["log", "--format=%H", `${request.baseCommit}..HEAD`]),
  ]);

  const entries = lines(status)
    .map(changedPath)
    .filter((entry) => !request.allowedPrefixes.some((prefix) => entry.path.startsWith(prefix)));
  const commits = lines(log);

  const inspection = {
    worktreePath: request.worktreePath,
    present: true,
    branch: branch === null ? null : branch.trim(),
    head: head.trim(),
    unexpectedWork: entries.filter((one) => one.status !== "!!").map((one) => one.path),
    unknownIgnored: entries.filter((one) => one.status === "!!").map((one) => one.path),
    commits,
    unpushed: await unpushedCommits(request.worktreePath, commits),
  };

  return { ...inspection, identity: ContentIdentity.of(inspection) };
}
