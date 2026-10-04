import { ContentIdentity } from "../content-identity/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";

export type CheckoutInspection = {
  worktreePath: string;
  present: boolean;
  /** The branch HEAD is on, or null for a detached HEAD. */
  branch: string | null;
  head: string | null;
  /** Changed or untracked paths that Operator did not write. */
  unexpectedWork: string[];
  /** Ignored paths that Operator did not write, which no status listing shows by default. */
  unknownIgnored: string[];
  identity: string;
};

async function git(worktreePath: string, args: string[]): Promise<string | null> {
  const read = await ToolInvocation.git({ repoRoot: worktreePath, args, raw: true });
  return read.status === "read" ? read.value : null;
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

/**
 * Reads one Operative checkout as a disposal decision needs it.
 * Operator writes its own inputs and skills here, so those paths are excluded and whatever
 * remains is work this crew never placed. Ignored files are read as well, because a default
 * status listing hides exactly the files a cleanup must not discard in silence.
 */
export async function inspectCheckout(request: {
  worktreePath: string;
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
    };
    return { ...absent, identity: ContentIdentity.of(absent) };
  }

  const [branch, status] = await Promise.all([
    // A detached HEAD is on no branch, so the read fails and the branch is null.
    git(request.worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    // Every untracked and ignored path is listed on its own, so a collapsed directory hides nothing.
    git(request.worktreePath, ["status", "--porcelain", "-uall", "--ignored"]),
  ]);

  const entries = lines(status)
    .map(changedPath)
    .filter((entry) => !request.allowedPrefixes.some((prefix) => entry.path.startsWith(prefix)));

  const inspection = {
    worktreePath: request.worktreePath,
    present: true,
    branch: branch === null ? null : branch.trim(),
    head: head.trim(),
    unexpectedWork: entries.filter((one) => one.status !== "!!").map((one) => one.path),
    unknownIgnored: entries.filter((one) => one.status === "!!").map((one) => one.path),
  };

  return { ...inspection, identity: ContentIdentity.of(inspection) };
}
