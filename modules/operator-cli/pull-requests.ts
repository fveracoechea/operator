import { PullRequests } from "../pull-requests/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { respond } from "./output.ts";

const defaultTimeoutSeconds = 300;
const ownerCommands = ["associate", "wait", "merge"] as const;

/** The SuperAgent names the merged assignment, because cleanup runs outside the worktree. */
function cleanupArgs(flags: string[]) {
  let sourceId: string | undefined;
  let assignment: string | undefined;
  let personInstructed = false;
  const seen = new Set<string>();
  const rest = flags.values();
  for (const flag of rest) {
    if (seen.has(flag)) return null;
    seen.add(flag);
    if (flag === "--json") continue;
    if (flag === "--person-instructed") personInstructed = true;
    else if (flag === "--source" || flag === "--assignment") {
      const value = rest.next().value;
      if (value === undefined || value.startsWith("--")) return null;
      if (flag === "--source") sourceId = value;
      else assignment = value;
    } else return null;
  }
  return sourceId === undefined || assignment === undefined
    ? null
    : { operation: "cleanup" as const, sourceId, assignment, personInstructed };
}

/** The association starts the handoff. The SuperAgent repeats it after a failure. */
function handoffArgs(flags: string[]) {
  const values = new Map<string, string>();
  const rest = flags.values();
  for (const flag of rest) {
    if (flag === "--json" && !values.has(flag)) values.set(flag, "");
    else if (["--source", "--assignment", "--after-pid"].includes(flag) && !values.has(flag)) {
      const value = rest.next().value;
      if (value === undefined || value.startsWith("--")) return null;
      values.set(flag, value);
    } else return null;
  }
  const sourceId = values.get("--source");
  const assignment = values.get("--assignment");
  const afterPid = values.get("--after-pid");
  if (sourceId === undefined || assignment === undefined) return null;
  if (afterPid !== undefined && !/^\d{1,10}$/.test(afterPid)) return null;
  return {
    operation: "handoff" as const,
    sourceId,
    assignment,
    afterPid: afterPid === undefined ? null : Number(afterPid),
  };
}

/** The reviewer names its findings file. Its worktree still selects the assignment. */
function roundArgs(flags: string[]) {
  let json = false;
  let file: string | undefined;
  const rest = flags.values();
  for (const flag of rest) {
    if (flag === "--json" && !json) json = true;
    else if (flag === "--file" && file === undefined) {
      const value = rest.next().value;
      if (value === undefined || value.startsWith("--")) return null;
      file = value;
    } else return null;
  }
  return file === undefined ? null : { operation: "pr_round" as const, file };
}

/** No owner flag selects an assignment or a PR. The caller's worktree is the only selector. */
export function pullRequestArgs(args: string[]) {
  const [group, name, ...flags] = args;
  if (group === "cleanup") return cleanupArgs(args.slice(1));
  if (group === "handoff") return handoffArgs(args.slice(1));
  if (group === "pr" && name === "round") return roundArgs(flags);
  const command = ownerCommands.find((known) => known === name);
  if (group !== "pr" || command === undefined) return null;
  return ownerArgs(command, flags);
}

function ownerArgs(command: string, flags: string[]) {
  let json = false;
  let timeoutSeconds: number | undefined;
  const rest = flags.values();
  for (const flag of rest) {
    if (flag === "--json" && !json) json = true;
    else if (flag === "--timeout" && command === "wait" && timeoutSeconds === undefined) {
      // An absent value reads as "undefined", which the pattern refuses.
      const value = String(rest.next().value);
      if (!/^\d{1,5}$/.test(value)) return null;
      timeoutSeconds = Number(value);
    } else return null;
  }
  if (command === "merge") return { operation: "pr_merge" as const };
  return command === "associate"
    ? { operation: "pr_associate" as const }
    : { operation: "pr_wait" as const, timeoutSeconds: timeoutSeconds ?? defaultTimeoutSeconds };
}

const pullRequestExitCodes = {
  pr_worktree_unrecorded: 4,
  pr_owner_inactive: 4,
  pr_repository_mismatch: 4,
  pr_branch_mismatch: 4,
  pr_already_associated: 4,
  pr_owned_elsewhere: 4,
  pr_base_invalid: 4,
  pr_io_failed: 1,
  github_failed: 1,
  github_uncertain: 1,
  github_invalid_response: 1,
  pr_merge_refused: 1,
  pr_merge_unverified: 1,
  cleanup_failed: 1,
  relay_fetch_failed: 1,
  relay_push_failed: 1,
  relay_retarget_failed: 1,
  relay_claim_lost: 1,
  pr_handed_off: 4,
  handoff_defect: 1,
  // The handoff closes a pane and dispatches, so their failures exit as a dispatch does.
  handoff_running: 4,
  handoff_not_found: 4,
  herdr_session_mismatch: 4,
  assignment_not_dispatchable: 4,
  launch_failed: 1,
  launch_interrupted: 1,
  dispatch_io_failed: 1,
  preparation_failed: 1,
  preparation_io_failed: 1,
  herdr_unavailable: 1,
  herdr_failed: 1,
  herdr_no_answer: 1,
  herdr_invalid_response: 1,
  host_metadata_failed: 1,
};

export async function runPullRequests(
  args: string[],
  paths: ReturnType<typeof OperatorHome.resolve>,
  json: boolean,
) {
  const parsed = pullRequestArgs(args);
  if (parsed === null) return false;
  const input = { paths, cwd: process.cwd() };
  const result = await (parsed.operation === "cleanup"
    ? PullRequests.cleanup({ ...input, ...parsed })
    : parsed.operation === "handoff"
      ? PullRequests.handoff({ ...input, ...parsed })
      : parsed.operation === "pr_round"
        ? PullRequests.round({ ...input, file: parsed.file })
        : parsed.operation === "pr_merge"
          ? PullRequests.merge(input)
          : parsed.operation === "pr_associate"
            ? PullRequests.associate(input)
            : PullRequests.wait({ ...input, timeoutSeconds: parsed.timeoutSeconds }));
  respond({
    operation: parsed.operation,
    result,
    exitCodes: pullRequestExitCodes,
    defect: "pr_defect",
    json,
  });
  return true;
}
