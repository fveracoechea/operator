import { GithubApi } from "../github-api/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";

const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 60_000;

type Outcome<Value> =
  Awaited<ReturnType<typeof GithubApi.call>> extends infer Answer
    ? Answer extends { status: "succeeded" }
      ? { status: "succeeded"; value: Value }
      : Answer
    : never;

export type Merged =
  | { status: "merged"; comparison: string }
  | { status: "not-merged"; comparison: string }
  | { status: "unknown"; detail: string };

export type Checked =
  | { status: "passed"; runs: number }
  | { status: "not-passed"; failing: string[]; runs: number }
  | { status: "unknown"; detail: string };

export type TagState =
  | { status: "absent" }
  | { status: "present"; sha: string }
  | { status: "unknown"; detail: string };

/** Reads whether the commit is already in the branch a release is cut from. */
export async function readMerged(request: {
  repository: string;
  base: string;
  commit: string;
}): Promise<Merged> {
  const outcome = await GithubApi.call({
    args: [`repos/${request.repository}/compare/${request.base}...${request.commit}`],
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (outcome.status !== "succeeded") {
    return { status: "unknown", detail: outcome.detail };
  }

  const comparison = ToolInvocation.text(outcome.value.body, "status") ?? "unknown";
  // `identical` and `behind` both mean the commit is already an ancestor of the base branch.
  return comparison === "identical" || comparison === "behind"
    ? { status: "merged", comparison }
    : { status: "not-merged", comparison };
}

/** Reads whether every check run of the commit concluded successfully. */
export async function readChecks(request: {
  repository: string;
  commit: string;
}): Promise<Checked> {
  const outcome = await GithubApi.call({
    args: [`repos/${request.repository}/commits/${request.commit}/check-runs`, "--paginate"],
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (outcome.status !== "succeeded") {
    return { status: "unknown", detail: outcome.detail };
  }

  const runs = ToolInvocation.list(outcome.value.body, "check_runs");
  if (runs.length === 0) {
    return { status: "unknown", detail: "No check run is recorded for that commit." };
  }

  const failing = runs
    .filter((run) => ToolInvocation.text(run, "conclusion") !== "success")
    .map(
      (run) =>
        `${ToolInvocation.text(run, "name") ?? "unnamed"}: ${ToolInvocation.text(run, "conclusion") ?? "unfinished"}`,
    );

  return failing.length === 0
    ? { status: "passed", runs: runs.length }
    : { status: "not-passed", failing, runs: runs.length };
}

/** Reads the commit one tag names, if the tag exists at all. */
export async function readTag(request: { repository: string; tag: string }): Promise<TagState> {
  const outcome = await GithubApi.call({
    args: [`repos/${request.repository}/git/ref/tags/${request.tag}`],
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (outcome.status === "failed" && outcome.httpStatus === 404) {
    return { status: "absent" };
  }
  if (outcome.status !== "succeeded") {
    return { status: "unknown", detail: outcome.detail };
  }

  const object = ToolInvocation.record(outcome.value.body, "object");
  const sha = ToolInvocation.text(object, "sha");
  return sha === null
    ? { status: "unknown", detail: "The tag named no commit." }
    : { status: "present", sha };
}

/** Creates one immutable tag. A tag that already exists is never moved. */
export async function createTag(request: {
  repository: string;
  tag: string;
  commit: string;
}): Promise<Outcome<{ ref: string }>> {
  const outcome = await GithubApi.call({
    args: [`repos/${request.repository}/git/refs`, "--method", "POST", "--input", "-"],
    input: JSON.stringify({ ref: `refs/tags/${request.tag}`, sha: request.commit }),
    timeoutMs: WRITE_TIMEOUT_MS,
  });

  return outcome.status === "succeeded"
    ? { status: "succeeded", value: { ref: `refs/tags/${request.tag}` } }
    : outcome;
}

/** Reads whether a release already exists for one tag. */
export async function readRelease(request: {
  repository: string;
  tag: string;
}): Promise<
  { status: "absent" } | { status: "present"; url: string } | { status: "unknown"; detail: string }
> {
  const outcome = await GithubApi.call({
    args: [`repos/${request.repository}/releases/tags/${request.tag}`],
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (outcome.status === "failed" && outcome.httpStatus === 404) {
    return { status: "absent" };
  }
  if (outcome.status !== "succeeded") {
    return { status: "unknown", detail: outcome.detail };
  }

  return { status: "present", url: ToolInvocation.text(outcome.value.body, "html_url") ?? "" };
}

/** Creates the release that carries the source delivery path of one version. */
export async function createRelease(request: {
  repository: string;
  tag: string;
  name: string;
  body: string;
}): Promise<Outcome<{ url: string }>> {
  const outcome = await GithubApi.call({
    args: [`repos/${request.repository}/releases`, "--method", "POST", "--input", "-"],
    input: JSON.stringify({
      tag_name: request.tag,
      name: request.name,
      body: request.body,
      draft: false,
      prerelease: false,
    }),
    timeoutMs: WRITE_TIMEOUT_MS,
  });

  return outcome.status === "succeeded"
    ? {
        status: "succeeded",
        value: { url: ToolInvocation.text(outcome.value.body, "html_url") ?? "" },
      }
    : outcome;
}
