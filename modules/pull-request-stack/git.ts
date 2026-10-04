import { ToolInvocation } from "../tool-invocation/main.ts";

type Read<Value> = { status: "read"; value: Value } | { status: "unread"; detail: string };

/** The detail of a Git failure, as this module words it. */
function failed(failure: Parameters<typeof ToolInvocation.gitFailure>[0]): string {
  return failure.kind === "exit" ? failure.stderr.trim() : ToolInvocation.gitFailure(failure);
}

/** The `<owner>/<repo>` one GitHub remote URL names, lowercase, or null for any other URL. */
function repositoryOfUrl(url: string): string | null {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url);
  return match?.[1] === undefined || match[2] === undefined
    ? null
    : `${match[1]}/${match[2]}`.toLowerCase();
}

export type Remote = { name: string; url: string };

/**
 * The one remote whose URL names the repository of the source (decision 12). The URL is read as
 * configured, before any rewrite, because the configured URL is what names the repository.
 */
export async function remoteOf(
  repoRoot: string,
  repository: string,
): Promise<
  | { status: "found"; remote: Remote }
  | { status: "missing" }
  | { status: "ambiguous"; remotes: Remote[] }
  | { status: "unread"; detail: string }
> {
  // `git config --get-regexp` exits 1 when no remote is configured.
  const invoked = await ToolInvocation.git({
    repoRoot,
    args: ["config", "--get-regexp", "^remote\\..*\\.url$"],
    raw: true,
    timeoutMs: 60_000,
    answers: [0, 1],
    failed,
  });
  if (invoked.status !== "read") {
    return invoked;
  }
  const remotes = invoked.value
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [key = "", url = ""] = line.split(/\s+/, 2);
      return { name: key.slice("remote.".length, -".url".length), url };
    })
    .filter((one) => repositoryOfUrl(one.url) === repository.toLowerCase());
  const [only] = remotes;
  if (only === undefined) {
    return { status: "missing" };
  }
  return remotes.length === 1
    ? { status: "found", remote: only }
    : { status: "ambiguous", remotes };
}

/** The commit each named branch holds on the remote. A branch that is absent is left out. */
export async function remoteBranches(
  repoRoot: string,
  remote: string,
  names: string[],
): Promise<Read<Map<string, string>>> {
  const listed = await ToolInvocation.git({
    repoRoot,
    args: ["ls-remote", "--heads", remote, ...names.map((one) => `refs/heads/${one}`)],
    timeoutMs: 60_000,
  });
  if (listed.status !== "read") {
    return listed;
  }
  const found = new Map<string, string>();
  for (const line of listed.value.split("\n").filter((one) => one.length > 0)) {
    const [commit = "", ref = ""] = line.split("\t");
    const name = ref.replace(/^refs\/heads\//, "");
    if (names.includes(name)) {
      found.set(name, commit);
    }
  }
  return { status: "read", value: found };
}

/**
 * Reads the tip of the target branch on the remote and fetches that one commit. The fetch names
 * no destination and writes no FETCH_HEAD, so it moves no ref of the project (ticket #118).
 */
export async function fetchTarget(
  repoRoot: string,
  remote: string,
  target: string,
): Promise<Read<string>> {
  const tips = await remoteBranches(repoRoot, remote, [target]);
  if (tips.status !== "read") {
    return tips;
  }
  const tip = tips.value.get(target);
  if (tip === undefined) {
    return { status: "unread", detail: `The remote ${remote} holds no branch ${target}.` };
  }
  const fetched = await ToolInvocation.git({
    repoRoot,
    args: ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, tip],
    timeoutMs: 60_000,
  });
  return fetched.status === "read" ? { status: "read", value: tip } : fetched;
}

export async function isAncestor(
  repoRoot: string,
  base: string,
  tip: string,
): Promise<Read<boolean>> {
  const invoked = await ToolInvocation.git({
    repoRoot,
    args: ["merge-base", "--is-ancestor", base, tip],
    timeoutMs: 60_000,
    answers: [0, 1],
    failed,
  });
  return invoked.status === "read" ? { status: "read", value: invoked.exitCode === 0 } : invoked;
}

export async function commitsBetween(
  repoRoot: string,
  base: string,
  tip: string,
): Promise<Read<number>> {
  const counted = await ToolInvocation.git({
    repoRoot,
    args: ["rev-list", "--count", `${base}..${tip}`],
    timeoutMs: 60_000,
  });
  return counted.status === "read" ? { status: "read", value: Number(counted.value) } : counted;
}

/** Whether the head merges onto the tip with no conflict. A merge with no worktree, as landing. */
export async function mergesCleanly(
  repoRoot: string,
  tip: string,
  head: string,
): Promise<Read<boolean>> {
  const merged = await ToolInvocation.git({
    repoRoot,
    args: ["merge-tree", "--write-tree", "--no-messages", tip, head],
    timeoutMs: 60_000,
    answers: [0, 1],
    failed,
  });
  return merged.status === "read" ? { status: "read", value: merged.exitCode === 0 } : merged;
}

export async function subjectOf(repoRoot: string, commit: string): Promise<Read<string>> {
  const subject = await ToolInvocation.git({
    repoRoot,
    args: ["log", "-1", "--format=%s", commit],
    timeoutMs: 60_000,
  });
  return subject.status === "read" ? { status: "read", value: subject.value } : subject;
}

/**
 * One atomic push of new branch names, with no force option of any kind (decision 13). Each
 * refspec names a full commit and a full ref, so no user setting chooses what is pushed.
 */
export async function pushNew(
  repoRoot: string,
  remote: string,
  refs: Array<{ name: string; commit: string }>,
): Promise<
  | { status: "pushed" }
  | { status: "rejected"; message: string }
  | { status: "no-answer"; detail: string }
> {
  const invoked = await ToolInvocation.git({
    repoRoot,
    args: [
      "push",
      "--atomic",
      "--porcelain",
      "--no-verify",
      remote,
      ...refs.map((one) => `${one.commit}:refs/heads/${one.name}`),
    ],
    timeoutMs: 300_000,
    answers: "any",
  });
  if (invoked.status !== "read") {
    return { status: "no-answer", detail: invoked.detail };
  }
  return invoked.exitCode === 0
    ? { status: "pushed" }
    : { status: "rejected", message: `${invoked.value}\n${invoked.stderr.trim()}`.trim() };
}
