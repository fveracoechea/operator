import { GithubApi } from "../github-api/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";

const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 60_000;

type Outcome = Awaited<ReturnType<typeof GithubApi.call>>;

function detailOf(outcome: Exclude<Outcome, { status: "succeeded" }>): string {
  return outcome.status === "failed" ? `${outcome.code}: ${outcome.detail}` : outcome.detail;
}

export type MergeSettings = {
  target: string;
  allowMergeCommit: boolean;
  /** The other merge methods the repository allows, which the preview names. */
  otherMethods: string[];
};

/** The default branch and the merge methods of one repository, read at the plan (decision 5). */
export async function readRepository(
  repository: string,
): Promise<{ status: "read"; value: MergeSettings } | { status: "unread"; detail: string }> {
  const outcome = await GithubApi.call({
    args: [`repos/${repository}`],
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (outcome.status !== "succeeded") {
    return { status: "unread", detail: detailOf(outcome) };
  }
  const body = outcome.value.body;
  const target = ToolInvocation.text(body, "default_branch");
  const merge = ToolInvocation.record(body, "allow_merge_commit");
  if (target === null || typeof merge !== "boolean") {
    return {
      status: "unread",
      detail: `GitHub answered for ${repository} with no default branch or merge setting.`,
    };
  }
  return {
    status: "read",
    value: {
      target,
      allowMergeCommit: merge,
      otherMethods: [
        ...(ToolInvocation.record(body, "allow_squash_merge") === true ? ["squash"] : []),
        ...(ToolInvocation.record(body, "allow_rebase_merge") === true ? ["rebase"] : []),
      ],
    },
  };
}

export type BranchRules = {
  signaturesRequired: boolean;
  linearHistory: boolean;
  /** The merge methods a ruleset allows, or null when no ruleset limits them. */
  allowedMethods: string[] | null;
};

/**
 * The active rules of the target branch. The endpoint returns only ruleset rules, never classic
 * branch protection, which needs admin rights to read (ticket #118). So the caller shows classic
 * protection as unverified, and an unreadable answer as unverified, never as a pass.
 */
export async function readRules(
  repository: string,
  target: string,
): Promise<{ status: "read"; value: BranchRules } | { status: "unread"; detail: string }> {
  const outcome = await GithubApi.call({
    args: [`repos/${repository}/rules/branches/${encodeURIComponent(target)}`],
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (outcome.status !== "succeeded") {
    return { status: "unread", detail: detailOf(outcome) };
  }
  if (!Array.isArray(outcome.value.body)) {
    return { status: "unread", detail: "GitHub answered the branch rules with no list." };
  }
  const rules: unknown[] = outcome.value.body;
  const typeOf = (rule: unknown) => ToolInvocation.text(rule, "type");
  const methods = rules
    .filter((rule) => typeOf(rule) === "pull_request")
    .map((rule) =>
      ToolInvocation.list(ToolInvocation.record(rule, "parameters"), "allowed_merge_methods"),
    )
    .filter((list) => list.length > 0)
    .map((list) => list.filter((one): one is string => typeof one === "string"));
  return {
    status: "read",
    value: {
      signaturesRequired: rules.some((rule) => typeOf(rule) === "required_signatures"),
      linearHistory: rules.some((rule) => typeOf(rule) === "required_linear_history"),
      // Each ruleset limits on its own, so a method passes only when every one allows it.
      allowedMethods:
        methods.length === 0
          ? null
          : (methods[0] ?? []).filter((one) => methods.every((list) => list.includes(one))),
    },
  };
}

export type PullRequest = { number: number; url: string; state: string };

function readPull(source: unknown): PullRequest | null {
  const number = ToolInvocation.number(source, "number");
  const url = ToolInvocation.text(source, "html_url");
  const state = ToolInvocation.text(source, "state");
  return number === null || url === null || state === null ? null : { number, url, state };
}

/**
 * Every pull request whose head is one branch of the repository, in every state. GitHub allows
 * one open pull request for a head, and a head name is new for each publication, so this is the
 * recovery key of a create (decision 14). `state=all` is required: the default is open only.
 */
export async function pullsByHead(
  repository: string,
  head: string,
): Promise<{ status: "read"; value: PullRequest[] } | { status: "unread"; detail: string }> {
  const owner = repository.split("/")[0] ?? "";
  const outcome = await GithubApi.call({
    args: [
      `repos/${repository}/pulls?state=all&per_page=100&head=${encodeURIComponent(`${owner}:${head}`)}`,
    ],
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (outcome.status !== "succeeded") {
    return { status: "unread", detail: detailOf(outcome) };
  }
  const rows = Array.isArray(outcome.value.body) ? outcome.value.body : null;
  const read = rows?.map(readPull) ?? null;
  if (read === null || read.some((one) => one === null)) {
    return {
      status: "unread",
      detail: "GitHub answered with a pull request list this release cannot read.",
    };
  }
  return { status: "read", value: read.filter((one) => one !== null) };
}

/**
 * Opens one pull request, ready for review. It never asks for auto-merge and never merges:
 * a person merges (ADR 0022, decision D6).
 */
export async function createPull(
  repository: string,
  request: { head: string; base: string; title: string; body: string },
): Promise<
  | { status: "created"; value: PullRequest }
  | { status: "failed"; message: string }
  | { status: "uncertain"; detail: string }
> {
  const outcome = await GithubApi.call({
    args: ["--method", "POST", `repos/${repository}/pulls`, "--input", "-"],
    input: JSON.stringify({
      title: request.title,
      head: request.head,
      base: request.base,
      body: request.body,
      draft: false,
      maintainer_can_modify: false,
    }),
    timeoutMs: WRITE_TIMEOUT_MS,
  });
  if (outcome.status === "failed") {
    return { status: "failed", message: detailOf(outcome) };
  }
  if (outcome.status === "uncertain") {
    return outcome;
  }
  const created = readPull(outcome.value.body);
  return created === null
    ? { status: "uncertain", detail: "GitHub accepted a pull request it did not describe." }
    : { status: "created", value: created };
}

/** What GitHub shows of one pull request, in the fields the merge observation reads. */
export type PullState = {
  number: number;
  state: string;
  draft: boolean;
  merged: boolean;
  head: string;
  base: string;
  mergeCommit: string | null;
};

/** Reads one pull request by its number. It writes nothing. */
export async function readPullState(
  repository: string,
  number: number,
): Promise<{ status: "read"; value: PullState } | { status: "unread"; detail: string }> {
  const outcome = await GithubApi.call({
    args: [`repos/${repository}/pulls/${number}`],
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (outcome.status !== "succeeded") {
    return { status: "unread", detail: detailOf(outcome) };
  }
  const body = outcome.value.body;
  const state = ToolInvocation.text(body, "state");
  const head = ToolInvocation.text(ToolInvocation.record(body, "head"), "sha");
  const base = ToolInvocation.text(ToolInvocation.record(body, "base"), "ref");
  const merged = ToolInvocation.record(body, "merged");
  if (state === null || head === null || base === null || typeof merged !== "boolean") {
    return {
      status: "unread",
      detail: `GitHub answered pull request #${number} with no state, head, base, or merge flag.`,
    };
  }
  return {
    status: "read",
    value: {
      number,
      state,
      draft: ToolInvocation.record(body, "draft") === true,
      merged,
      head,
      base,
      mergeCommit: ToolInvocation.text(body, "merge_commit_sha"),
    },
  };
}

/** The parents of one commit GitHub holds, which tell a merge commit from a squash or rebase. */
export async function readParents(
  repository: string,
  commit: string,
): Promise<{ status: "read"; value: string[] } | { status: "unread"; detail: string }> {
  const outcome = await GithubApi.call({
    args: [`repos/${repository}/commits/${commit}`],
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (outcome.status !== "succeeded") {
    return { status: "unread", detail: detailOf(outcome) };
  }
  const parents = ToolInvocation.list(outcome.value.body, "parents").map((one) =>
    ToolInvocation.text(one, "sha"),
  );
  if (parents.length === 0 || parents.some((one) => one === null)) {
    return { status: "unread", detail: `GitHub answered commit ${commit} with no parents.` };
  }
  return { status: "read", value: parents.filter((one) => one !== null) };
}

/**
 * Changes the base of one pull request. It sends the base and nothing else, so it never merges,
 * never asks for auto-merge, and never changes the title or the body (ADR 0022, decision D6).
 */
export async function retargetPull(
  repository: string,
  number: number,
  base: string,
): Promise<
  | { status: "changed" }
  | { status: "failed"; message: string }
  | { status: "uncertain"; detail: string }
> {
  const outcome = await GithubApi.call({
    args: ["--method", "PATCH", `repos/${repository}/pulls/${number}`, "--input", "-"],
    input: JSON.stringify({ base }),
    timeoutMs: WRITE_TIMEOUT_MS,
  });
  if (outcome.status === "succeeded") {
    return { status: "changed" };
  }
  return outcome.status === "failed"
    ? { status: "failed", message: detailOf(outcome) }
    : { status: "uncertain", detail: outcome.detail };
}

/** The bodies of the comments on one pull request, oldest first. It writes nothing. */
export async function commentsOf(
  repository: string,
  number: number,
): Promise<{ status: "read"; value: string[] } | { status: "unread"; detail: string }> {
  const outcome = await GithubApi.call({
    args: [`repos/${repository}/issues/${number}/comments?per_page=100`],
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (outcome.status !== "succeeded") {
    return { status: "unread", detail: detailOf(outcome) };
  }
  const listed = Array.isArray(outcome.value.body) ? outcome.value.body : [];
  return {
    status: "read",
    value: listed.map((one) => ToolInvocation.text(one, "body") ?? ""),
  };
}

/** Writes one comment on one pull request. */
export async function commentOn(
  repository: string,
  number: number,
  body: string,
): Promise<
  | { status: "written" }
  | { status: "failed"; message: string }
  | { status: "uncertain"; detail: string }
> {
  const outcome = await GithubApi.call({
    args: ["--method", "POST", `repos/${repository}/issues/${number}/comments`, "--input", "-"],
    input: JSON.stringify({ body }),
    timeoutMs: WRITE_TIMEOUT_MS,
  });
  if (outcome.status === "succeeded") {
    return { status: "written" };
  }
  return outcome.status === "failed"
    ? { status: "failed", message: detailOf(outcome) }
    : { status: "uncertain", detail: outcome.detail };
}

/**
 * Closes one pull request with no merge. It sends the state and nothing else, so it never
 * merges and never deletes its branch (ADR 0022, D6, R3).
 */
export async function closePull(
  repository: string,
  number: number,
): Promise<
  | { status: "closed" }
  | { status: "failed"; message: string }
  | { status: "uncertain"; detail: string }
> {
  const outcome = await GithubApi.call({
    args: ["--method", "PATCH", `repos/${repository}/pulls/${number}`, "--input", "-"],
    input: JSON.stringify({ state: "closed" }),
    timeoutMs: WRITE_TIMEOUT_MS,
  });
  if (outcome.status === "succeeded") {
    return { status: "closed" };
  }
  return outcome.status === "failed"
    ? { status: "failed", message: detailOf(outcome) }
    : { status: "uncertain", detail: outcome.detail };
}
