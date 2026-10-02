import type { CrewState } from "../crew-state/main.ts";
import type { refuse } from "./result.ts";

// A result that no longer lands as it was reviewed goes to a fresh Operative (ADR 0020).
const INTEGRATION_LINE =
  "Delegate an integration cycle with `operator work rework` and the reason `integration`.";

/** Every refusal of a landing, as `work accept` and `work rework` report it. */
export type LandingRefusalResult = Extract<
  | Awaited<ReturnType<typeof CrewState.accept>>["result"]
  | Awaited<ReturnType<typeof CrewState.rework>>["result"],
  {
    status:
      | "integration-branch-missing"
      | "integration-branch-moved"
      | "integration-branch-checked-out"
      | "integration-branch-unread"
      | "landing-conflict"
      | "landing-patch-changed"
      | "landing-gate-not-passed"
      | "landing-pending"
      | "landing-tip-changed";
  }
>;

/** The lines and the outcome of one refusal of a landing. Each one landed and recorded nothing. */
export function landingRefusalOf(
  result: LandingRefusalResult,
  retry: "accept" | "delegate the cycle",
): {
  outcome: "missing-condition" | "conflict" | "pending" | "uncertain";
  reason: Parameters<typeof refuse>[0]["reason"];
  lines: string[];
} {
  switch (result.status) {
    case "integration-branch-missing":
      return {
        outcome: "missing-condition",
        reason: "integration_branch_missing",
        lines: [
          `Source ${result.sourceId} records no integration branch, so its code result has nowhere to land.`,
        ],
      };
    case "integration-branch-moved":
      return {
        outcome: "conflict",
        reason: "integration_branch_moved",
        lines: [
          `The branch ${result.branch} holds ${result.found ?? "no commit"}, and the recorded tip is ${result.recordedTip}.`,
          ...(result.checkedOut.length === 0
            ? []
            : [`It is checked out in ${result.checkedOut.join(", ")}.`]),
          `Operator never resets or adopts a moved branch. The person puts it back at the recorded tip, then ${retry} again.`,
        ],
      };
    case "integration-branch-checked-out":
      return {
        outcome: "conflict",
        reason: "integration_branch_checked_out",
        lines: [
          `The branch ${result.branch} is checked out in ${result.worktrees.join(", ")}, so it is not moved under that worktree.`,
          `The person switches that worktree off the branch, then ${retry} again.`,
        ],
      };
    case "integration-branch-unread":
      return {
        outcome: "uncertain",
        reason: "integration_branch_unread",
        lines: [`Git cannot read the branch ${result.branch}: ${result.detail}`],
      };
    case "landing-conflict":
      return {
        outcome: "conflict",
        reason: "landing_conflict",
        lines: [
          `Commit ${result.commit} conflicts with the tip ${result.tip} of ${result.branch} in ${result.paths.join(", ")}.`,
          INTEGRATION_LINE,
        ],
      };
    case "landing-patch-changed":
      return {
        outcome: "conflict",
        reason: "landing_patch_changed",
        lines: [
          `Commit ${result.commit} would land on ${result.tip} of ${result.branch} as another patch, so it is not the reviewed result.`,
          INTEGRATION_LINE,
        ],
      };
    case "landing-gate-not-passed":
      return {
        outcome:
          result.gate === "gate_pending" || result.gate === "gate_running" ? "pending" : "conflict",
        reason: result.gate,
        lines: [
          `The planned commit ${result.commit} on tip ${result.tip} has not passed the project gate.`,
          result.gate === "gate_pending"
            ? "No gate run is recorded at its key. Run `operator gate run --assignment <id>` first."
            : result.gate === "gate_running"
              ? `Gate run ${result.runIds.join(", ")} still runs at its key. Wait for its outcome.`
              : `The key is ${result.gate === "gate_flaky" ? "flaky" : "failed"} in gate run ${result.runIds.join(", ")}. Read it with \`operator gate show --run <id>\`.`,
          ...(result.gate === "gate_failed" || result.gate === "gate_flaky"
            ? [INTEGRATION_LINE]
            : []),
        ],
      };
    case "landing-pending":
      return {
        outcome: "pending",
        reason: "landing_pending",
        lines: [
          `Landing ${result.landingId} of assignment ${result.pendingAssignmentId} has no recorded outcome. Settle it first with \`operator work accept\` on that assignment.`,
        ],
      };
    default:
      return {
        outcome: "conflict",
        reason: "landing_tip_changed",
        lines: [
          `The landing was planned on ${result.planned}, and the recorded tip is now ${result.recordedTip ?? "none"}. ${retry === "accept" ? "Accept" : "Delegate the cycle"} again to plan it on the new tip.`,
        ],
      };
  }
}
