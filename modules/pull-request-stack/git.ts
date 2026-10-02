import { ToolInvocation } from "../tool-invocation/main.ts";

type Read<Value> = { status: "read"; value: Value } | { status: "unread"; detail: string };

async function git(repoRoot: string, args: string[], timeoutMs = 60_000) {
  const invoked = await ToolInvocation.run({
    tool: "git",
    args: ["-C", repoRoot, ...args],
    timeoutMs,
  });
  return invoked;
}

async function gitRead(repoRoot: string, args: string[]): Promise<Read<string>> {
  const invoked = await git(repoRoot, args);
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
  const invoked = await git(repoRoot, ["config", "--get-regexp", "^remote\\..*\\.url$"]);
  if (invoked.status !== "completed" || invoked.exitCode > 1) {
    return {
      status: "unread",
      detail: invoked.status === "completed" ? invoked.stderr.trim() : invoked.detail,
    };
  }
  // `git config --get-regexp` exits 1 when no remote is configured.
  const remotes = invoked.stdout
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
  const listed = await gitRead(repoRoot, [
    "ls-remote",
    "--heads",
    remote,
    ...names.map((one) => `refs/heads/${one}`),
  ]);
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
  const fetched = await gitRead(repoRoot, [
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-write-fetch-head",
    remote,
    tip,
  ]);
  return fetched.status === "read" ? { status: "read", value: tip } : fetched;
}

export async function isAncestor(
  repoRoot: string,
  base: string,
  tip: string,
): Promise<Read<boolean>> {
  const invoked = await git(repoRoot, ["merge-base", "--is-ancestor", base, tip]);
  if (invoked.status !== "completed" || invoked.exitCode > 1) {
    return {
      status: "unread",
      detail: invoked.status === "completed" ? invoked.stderr.trim() : invoked.detail,
    };
  }
  return { status: "read", value: invoked.exitCode === 0 };
}

export async function commitsBetween(
  repoRoot: string,
  base: string,
  tip: string,
): Promise<Read<number>> {
  const counted = await gitRead(repoRoot, ["rev-list", "--count", `${base}..${tip}`]);
  return counted.status === "read" ? { status: "read", value: Number(counted.value) } : counted;
}

/** Whether the head merges onto the tip with no conflict. A merge with no worktree, as landing. */
export async function mergesCleanly(
  repoRoot: string,
  tip: string,
  head: string,
): Promise<Read<boolean>> {
  const merged = await git(repoRoot, ["merge-tree", "--write-tree", "--no-messages", tip, head]);
  if (merged.status !== "completed" || merged.exitCode > 1) {
    return {
      status: "unread",
      detail: merged.status === "completed" ? merged.stderr.trim() : merged.detail,
    };
  }
  return { status: "read", value: merged.exitCode === 0 };
}

export async function subjectOf(repoRoot: string, commit: string): Promise<Read<string>> {
  return gitRead(repoRoot, ["log", "-1", "--format=%s", commit]);
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
  const invoked = await git(
    repoRoot,
    [
      "push",
      "--atomic",
      "--porcelain",
      "--no-verify",
      remote,
      ...refs.map((one) => `${one.commit}:refs/heads/${one.name}`),
    ],
    300_000,
  );
  if (invoked.status !== "completed") {
    return { status: "no-answer", detail: invoked.detail };
  }
  return invoked.exitCode === 0
    ? { status: "pushed" }
    : { status: "rejected", message: `${invoked.stdout.trim()}\n${invoked.stderr.trim()}`.trim() };
}
