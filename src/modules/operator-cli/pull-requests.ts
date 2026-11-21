import { PullRequests } from "../pull-requests/main.ts";
import { timeoutSeconds } from "../../lib/timeout-seconds.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { respond } from "./output.ts";
import { recoveryArgs } from "./internal-review-recovery-args.ts";

const defaultTimeoutSeconds = 540;
const ownerCommands = ["associate", "wait", "merge"] as const;

/**
 * The SuperAgent names the assignment, because cleanup and a skip of an internal review run
 * outside the worktree.
 */
function assignmentArgs(flags: string[]) {
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
    : { sourceId, assignment, personInstructed };
}

function cleanupArgs(flags: string[]) {
  const parsed = assignmentArgs(flags);
  return parsed === null ? null : { operation: "cleanup" as const, ...parsed };
}

/** The person's skip of a running internal review, which the SuperAgent attests. */
function skipArgs(flags: string[]) {
  const [name, ...rest] = flags;
  const parsed = name === "skip" ? assignmentArgs(rest) : null;
  return parsed === null ? null : { operation: "internal_review_skip" as const, ...parsed };
}

/** The reviewer names its findings or summary file. Its worktree still selects the assignment. */
function proseArgs(flags: string[], allowed: string[]) {
  const seen = new Set<string>();
  const parsed: { file?: string; note?: string } = {};
  const rest = flags.values();
  for (const flag of rest) {
    if (seen.has(flag)) return null;
    seen.add(flag);
    if (flag === "--json") continue;
    if (!allowed.includes(flag)) return null;
    const value = rest.next().value;
    if (value === undefined || value.startsWith("--")) return null;
    if (flag === "--file") parsed.file = value;
    else parsed.note = value;
  }
  return parsed.file === "-" && parsed.note === "-" ? null : parsed;
}

/** Worker commands select by worktree; a supervised parked merge names its assignment. */
function fileArgs(name: string, flags: string[]) {
  const parsed = proseArgs(flags, ["--file"]);
  if (parsed?.file === undefined) return null;
  return name === "round"
    ? { operation: "pr_round" as const, file: parsed.file }
    : { operation: "pr_validate" as const, file: parsed.file };
}

export function pullRequestArgs(args: string[]) {
  const [group, name, ...flags] = args;
  if (group === "cleanup") return cleanupArgs(args.slice(1));
  if (group === "internal-review")
    return name === "recover" ? recoveryArgs(flags) : skipArgs(args.slice(1));
  if (group === "pr" && (name === "round" || name === "validate")) {
    return fileArgs(name, flags);
  }
  if (group === "pr" && name === "ready") {
    const parsed = proseArgs(flags, ["--file", "--note"]);
    return parsed === null ? null : { operation: "pr_ready" as const, ...parsed };
  }
  const command = ownerCommands.find((known) => known === name);
  if (group !== "pr" || command === undefined) return null;
  return ownerArgs(command, flags);
}

function ownerArgs(command: string, flags: string[]) {
  if (command === "wait") return waitArgs(flags);
  if (command === "merge") return mergeArgs(flags);
  if (flags.length > 1 || flags.some((flag) => flag !== "--json")) return null;
  return { operation: "pr_associate" as const };
}

type MergeArgs =
  | { operation: "pr_merge"; sourceId?: never; assignment?: never }
  | { operation: "pr_merge"; sourceId: string; assignment: string };

function mergeArgs(flags: string[]): MergeArgs | null {
  if (flags.length <= 1 && flags.every((flag) => flag === "--json"))
    return { operation: "pr_merge" };
  if (flags.includes("--person-instructed")) return null;
  const parsed = assignmentArgs(flags);
  return parsed === null
    ? null
    : { operation: "pr_merge", sourceId: parsed.sourceId, assignment: parsed.assignment };
}

function waitArgs(flags: string[]) {
  const values: Record<string, string> = {};
  const rest = flags.values();
  for (const flag of rest) {
    if (Object.hasOwn(values, flag)) return null;
    if (flag === "--json") {
      values[flag] = "yes";
      continue;
    }
    if (!["--timeout", "--note"].includes(flag)) return null;
    const value = rest.next().value;
    if (value === undefined || value.startsWith("--")) return null;
    values[flag] = value;
  }
  const timeout = values["--timeout"];
  if (timeout !== undefined && timeoutSeconds(timeout) === null) return null;
  const parsed: { operation: "pr_wait"; timeoutSeconds: number; note?: string } = {
    operation: "pr_wait",
    timeoutSeconds: timeout === undefined ? defaultTimeoutSeconds : Number(timeout),
  };
  if (values["--note"] !== undefined) parsed.note = values["--note"];
  return parsed;
}

export const pullRequestExitCodes = {
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
  pr_enqueue_unverified: 1,
  pr_enqueue_refused: 1,
  pr_validation_stale: 4,
  pr_validation_blocked: 4,
  pr_merge_held: 4,
  pr_delivery_running: 4,
  pr_stack_running: 4,
  pr_owner_busy: 4,
  source_supervised_elsewhere: 4,
  cleanup_failed: 1,
  relay_fetch_failed: 1,
  relay_push_failed: 1,
  relay_retarget_failed: 1,
  relay_claim_lost: 1,
  pr_handed_off: 4,
  handoff_defect: 1,
  internal_review_defect: 1,
  internal_review_recovery_incompatible: 4,
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
  const result = await (parsed.operation === "pr_validate"
    ? PullRequests.validate({ ...input, file: parsed.file })
    : parsed.operation === "cleanup"
      ? PullRequests.cleanup({ ...input, ...parsed })
      : parsed.operation === "internal_review_recover"
        ? PullRequests.recoverReview({ ...input, ...parsed })
        : parsed.operation === "internal_review_skip"
          ? PullRequests.skipReview({ ...input, ...parsed })
          : parsed.operation === "pr_round"
            ? PullRequests.round({ ...input, file: parsed.file })
            : parsed.operation === "pr_ready"
              ? PullRequests.ready({ ...input, ...readyInput(parsed) })
              : parsed.operation === "pr_merge"
                ? PullRequests.merge(
                    parsed.sourceId !== undefined
                      ? { ...input, sourceId: parsed.sourceId, assignment: parsed.assignment }
                      : input,
                  )
                : parsed.operation === "pr_associate"
                  ? PullRequests.associate(input)
                  : PullRequests.wait({
                      ...input,
                      timeoutSeconds: parsed.timeoutSeconds,
                      ...readyInput(parsed),
                    }));
  respond({
    operation: parsed.operation,
    result,
    exitCodes: pullRequestExitCodes,
    defect: "pr_defect",
    json,
  });
  return true;
}

function readyInput(parsed: { file?: string; note?: string }) {
  const input: { file?: string; note?: string } = {};
  if (parsed.file !== undefined) input.file = parsed.file;
  if (parsed.note !== undefined) input.note = parsed.note;
  return input;
}
