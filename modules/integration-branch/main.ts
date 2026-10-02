import { ToolInvocation } from "../tool-invocation/main.ts";

/** The namespace of every integration branch, so no branch of a person or an Operative is one. */
const NAMESPACE = "operator/integration";

async function git(
  repoRoot: string,
  args: string[],
): Promise<{ status: "read"; value: string } | { status: "unread"; detail: string }> {
  const invoked = await ToolInvocation.run({
    tool: "git",
    args: ["-C", repoRoot, ...args],
    timeoutMs: 30_000,
  });
  return invoked.status === "completed" && invoked.exitCode === 0
    ? { status: "read", value: invoked.stdout.trim() }
    : {
        status: "unread",
        detail:
          invoked.status === "completed"
            ? `git ${args[0] ?? ""} exited ${invoked.exitCode}: ${invoked.stderr.trim()}`
            : invoked.detail,
      };
}

type Tip =
  | { status: "found"; commit: string }
  | { status: "absent" }
  | { status: "unread"; detail: string };

/** The commit one local branch holds, or `absent` when the branch does not exist. */
async function tipOf(repoRoot: string, name: string): Promise<Tip> {
  const invoked = await ToolInvocation.run({
    tool: "git",
    args: ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`],
    timeoutMs: 30_000,
  });
  if (invoked.status !== "completed") {
    return { status: "unread", detail: invoked.detail };
  }
  // `--verify --quiet` exits 1 with no output when the ref does not exist.
  return invoked.exitCode === 0
    ? { status: "found", commit: invoked.stdout.trim() }
    : { status: "absent" };
}

/** Every worktree of the shared repository that has the branch checked out. */
async function checkedOut(
  repoRoot: string,
  name: string,
): Promise<{ status: "read"; paths: string[] } | { status: "unread"; detail: string }> {
  const listed = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  if (listed.status !== "read") {
    return listed;
  }
  const paths: string[] = [];
  let path: string | null = null;
  for (const line of listed.value.split("\n")) {
    if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length);
    } else if (line === `branch refs/heads/${name}` && path !== null) {
      paths.push(path);
    }
  }
  return { status: "read", paths };
}

/**
 * The integration branch of one source (ADR 0020). This module is the only writer of it: a plain
 * local branch that it creates once at the integration base and moves only from its recorded
 * tip. It never resets a branch, never adopts a tip that it did not record, and never pushes.
 */
export const IntegrationBranch = {
  /** The name of the integration branch of one source, from the slug of the source. */
  nameOf(request: { sourceSlug: string }): string {
    return `${NAMESPACE}/${request.sourceSlug}`;
  },

  /**
   * Resolves one commit name to its full commit, so a recorded tip compares with what a caller
   * names.
   */
  async resolve(request: {
    repoRoot: string;
    commit: string;
  }): Promise<{ status: "resolved"; commit: string } | { status: "unresolved"; detail: string }> {
    const read = await git(request.repoRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${request.commit}^{commit}`,
    ]);
    return read.status === "read"
      ? { status: "resolved", commit: read.value }
      : { status: "unresolved", detail: `Git names no commit ${request.commit}.` };
  },

  /**
   * Creates the branch at the integration base. The ref is written only if it does not exist, so
   * a branch that a person made is never taken over. A repeat that finds the branch at the same
   * commit answers `created`, because an interrupted first dispatch may have made it already.
   */
  async create(request: {
    repoRoot: string;
    name: string;
    commit: string;
  }): Promise<
    | { status: "created"; name: string; commit: string }
    | { status: "exists"; name: string; found: string }
    | { status: "failed"; detail: string }
  > {
    const found = await tipOf(request.repoRoot, request.name);
    if (found.status === "unread") {
      return { status: "failed", detail: found.detail };
    }
    if (found.status === "found") {
      return found.commit === request.commit
        ? { status: "created", name: request.name, commit: request.commit }
        : { status: "exists", name: request.name, found: found.commit };
    }

    // An empty old value makes Git refuse when the ref appeared since the read above.
    const written = await git(request.repoRoot, [
      "update-ref",
      "-m",
      "operator: create the integration branch at its base",
      `refs/heads/${request.name}`,
      request.commit,
      "",
    ]);
    if (written.status === "read") {
      return { status: "created", name: request.name, commit: request.commit };
    }
    const after = await tipOf(request.repoRoot, request.name);
    if (after.status !== "found") {
      return { status: "failed", detail: written.detail };
    }
    return after.commit === request.commit
      ? { status: "created", name: request.name, commit: request.commit }
      : { status: "exists", name: request.name, found: after.commit };
  },

  /**
   * Reads the branch against its recorded tip. A branch that holds any other commit, or that is
   * gone, moved outside this protocol, and only a person puts it back. Each worktree that has the
   * branch checked out is named in both answers.
   */
  async read(request: {
    repoRoot: string;
    name: string;
    recordedTip: string;
  }): Promise<
    | { status: "at-tip"; checkedOut: string[] }
    | { status: "tip-moved"; found: string | null; checkedOut: string[] }
    | { status: "unread"; detail: string }
  > {
    const found = await tipOf(request.repoRoot, request.name);
    if (found.status === "unread") {
      return found;
    }
    const worktrees = await checkedOut(request.repoRoot, request.name);
    if (worktrees.status === "unread") {
      return worktrees;
    }
    const commit = found.status === "found" ? found.commit : null;
    return commit === request.recordedTip
      ? { status: "at-tip", checkedOut: worktrees.paths }
      : { status: "tip-moved", found: commit, checkedOut: worktrees.paths };
  },
};
