import { PullRequests } from "../pull-requests/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { failure } from "./output.ts";

const defaultTimeoutSeconds = 300;

/** No flag selects an assignment or a PR. The caller's worktree is the only selector. */
export function pullRequestArgs(args: string[]) {
  const [group, command, ...flags] = args;
  if (group !== "pr" || (command !== "associate" && command !== "wait")) return null;
  let json = false;
  let timeoutSeconds: number | undefined;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === "--json" && !json) json = true;
    else if (flag === "--timeout" && command === "wait" && timeoutSeconds === undefined) {
      const value = flags[++index] ?? "";
      if (!/^\d{1,5}$/.test(value)) return null;
      timeoutSeconds = Number(value);
    } else return null;
  }
  return command === "associate"
    ? { operation: "pr_associate" as const }
    : { operation: "pr_wait" as const, timeoutSeconds: timeoutSeconds ?? defaultTimeoutSeconds };
}

function exitCode(reason: string) {
  if (
    [
      "pr_worktree_unrecorded",
      "pr_owner_inactive",
      "pr_repository_mismatch",
      "pr_branch_mismatch",
      "pr_already_associated",
      "pr_owned_elsewhere",
    ].includes(reason)
  )
    return 4;
  if (
    [
      "state_busy",
      "state_io_failed",
      "pr_io_failed",
      "github_failed",
      "github_uncertain",
      "github_invalid_response",
    ].includes(reason)
  )
    return 1;
  return 3;
}

export async function runPullRequests(
  args: string[],
  paths: ReturnType<typeof OperatorHome.resolve>,
  json: boolean,
) {
  const parsed = pullRequestArgs(args);
  if (parsed === null) return false;
  const input = { paths, cwd: process.cwd() };
  const result = await (parsed.operation === "pr_associate"
    ? PullRequests.associate(input)
    : PullRequests.wait({ ...input, timeoutSeconds: parsed.timeoutSeconds }));
  if (result.tag === "Ok") {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          operation: parsed.operation,
          outcome: "completed",
          reason: result.value.reason,
          blockers: [],
          data: result.value.data,
        },
        null,
        json ? undefined : 2,
      ),
    );
    process.exitCode = 0;
  } else if (result.tag === "Err")
    failure(
      parsed.operation,
      result.error.reason,
      result.error.detail,
      exitCode(result.error.reason),
      json,
    );
  else failure(parsed.operation, "pr_defect", String(result.cause), 1, json);
  return true;
}
