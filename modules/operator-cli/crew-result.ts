import type { CrewState } from "../crew-state/main.ts";
import type { ParsedArguments } from "./arguments.ts";
import {
  answer,
  type Handled,
  type Operation,
  type Reason,
  type Refusal,
  report,
  type SharedStatus,
} from "./result.ts";

/**
 * Reports the outcomes every crew-state call shares, for a command that keeps its own refusals
 * outside a table. Returns true when it reported, so each command handles only its own outcomes.
 */
export function reportSharedFailure<Result extends { status: string }>(
  parsed: ParsedArguments,
  operation: Operation,
  result: Result,
): result is Extract<Result, { status: SharedStatus }> {
  return answer(parsed, operation, result, {});
}

/** The two refusals every command that names one inspected assignment shares. */
export const assignmentRefusals = {
  "unknown-assignment": (result: { assignmentId: string }): Refusal => ({
    outcome: "invalid",
    reason: "unknown_assignment",
    detail: { assignmentId: result.assignmentId },
    lines: [`No assignment is registered as ${result.assignmentId}.`],
  }),
  "stale-revision": (result: { assignmentId: string; recordedRevision: number }): Refusal => ({
    outcome: "conflict",
    reason: "stale_revision",
    detail: { assignmentId: result.assignmentId, recordedRevision: result.recordedRevision },
    lines: [
      `Assignment ${result.assignmentId} is at revision ${result.recordedRevision}.`,
      "Read it again, then state the revision you inspected.",
    ],
  }),
};

/** The refusal of a structured request that failed its schema, one blocker for each reason. */
function invalidInputOf(reason: Reason, issues: string[]): Refusal {
  return {
    outcome: "invalid",
    reason,
    blockers: issues.map((issue) => ({ reason, issue })),
    lines: ["The request is not valid:", ...issues.map((one) => `  ${one}`)],
  };
}

/** The table entry of a structured request that failed its schema. */
export function invalidInputRefusals(reason: Reason) {
  return {
    "invalid-input": (result: { issues: string[] }): Refusal =>
      invalidInputOf(reason, result.issues),
  };
}

// A result that no longer lands as it was reviewed goes to a fresh Operative (ADR 0020).
const INTEGRATION_LINE =
  "Delegate an integration cycle with `operator work rework` and the reason `integration`.";

/**
 * Every refusal of a landing, as `work accept`, `work rework`, and `work take-out` report it in
 * their one `landing-refused` variant.
 */
type LandingRefusal = Extract<
  Awaited<ReturnType<typeof CrewState.accept>>["result"],
  { status: "landing-refused" }
>["refusal"];

type LandingByCode = { [S in LandingRefusal["status"]]: Extract<LandingRefusal, { status: S }> };

/** The command that met the refusal, which the words name. */
type LandingCommand = {
  retry: "accept" | "delegate the cycle";
  // The gate run that the command owes: of an assignment, or of the source of a take-out.
  gateCommand: string;
};

/** The words of each landing refusal code. Each one landed and recorded nothing. */
const landingWords: {
  [S in keyof LandingByCode]: (
    result: LandingByCode[S],
    command: LandingCommand,
  ) => Pick<Refusal, "outcome" | "reason" | "lines">;
} = {
  "integration-branch-missing": (result) => ({
    outcome: "missing-condition",
    reason: "integration_branch_missing",
    lines: [
      `Source ${result.sourceId} records no integration branch, so its code result has nowhere to land.`,
    ],
  }),
  "integration-branch-moved": (result, command) => ({
    outcome: "conflict",
    reason: "integration_branch_moved",
    lines: [
      `The branch ${result.branch} holds ${result.found ?? "no commit"}, and the recorded tip is ${result.recordedTip}.`,
      ...(result.checkedOut.length === 0
        ? []
        : [`It is checked out in ${result.checkedOut.join(", ")}.`]),
      `Operator never resets or adopts a moved branch. The person puts it back at the recorded tip, then ${command.retry} again.`,
    ],
  }),
  "integration-branch-checked-out": (result, command) => ({
    outcome: "conflict",
    reason: "integration_branch_checked_out",
    lines: [
      `The branch ${result.branch} is checked out in ${result.worktrees.join(", ")}, so it is not moved under that worktree.`,
      `The person switches that worktree off the branch, then ${command.retry} again.`,
    ],
  }),
  "integration-branch-unread": (result) => ({
    outcome: "uncertain",
    reason: "integration_branch_unread",
    lines: [`Git cannot read the branch ${result.branch}: ${result.detail}`],
  }),
  "landing-conflict": (result) => ({
    outcome: "conflict",
    reason: "landing_conflict",
    lines: [
      `Commit ${result.commit} conflicts with the tip ${result.tip} of ${result.branch} in ${result.paths.join(", ")}.`,
      INTEGRATION_LINE,
    ],
  }),
  "landing-patch-changed": (result) => ({
    outcome: "conflict",
    reason: "landing_patch_changed",
    lines: [
      `Commit ${result.commit} would land on ${result.tip} of ${result.branch} as another patch, so it is not the reviewed result.`,
      INTEGRATION_LINE,
    ],
  }),
  "landing-gate-not-passed": (result, command) => ({
    outcome:
      result.gate === "gate_pending" || result.gate === "gate_running" ? "pending" : "conflict",
    reason: result.gate,
    lines: [
      `The planned commit ${result.commit} on tip ${result.tip} has not passed the project gate.`,
      result.gate === "gate_pending"
        ? `No gate run is recorded at its key. Run \`${command.gateCommand}\` first.`
        : result.gate === "gate_running"
          ? `Gate run ${result.runIds.join(", ")} still runs at its key. Wait for its outcome.`
          : `The key is ${result.gate === "gate_flaky" ? "flaky" : "failed"} in gate run ${result.runIds.join(", ")}. Read it with \`operator gate show --run <id>\`.`,
      ...(result.gate === "gate_failed" || result.gate === "gate_flaky" ? [INTEGRATION_LINE] : []),
    ],
  }),
  "landing-pending": (result) => ({
    outcome: "pending",
    reason: "landing_pending",
    lines: [
      `Landing ${result.landingId} of assignment ${result.pendingAssignmentId} has no recorded outcome. Settle it first with \`operator work accept\` on that assignment.`,
    ],
  }),
  "rebase-pending": (result) => ({
    outcome: "pending",
    reason: "rebase_pending",
    lines: [
      `Rebase ${result.rebaseId} of this source has no recorded outcome. Settle it first with \`operator work rebase\` and plan revision ${result.planRevision}.`,
    ],
  }),
  "rewrite-published-range": (result) => ({
    outcome: "conflict",
    reason: "rewrite_published_range",
    lines: [
      `Commit ${result.commit} of ${result.branch} is inside the range that pull request ${result.pullRequest ?? "(number not recorded)"} published${result.url === null ? "" : ` at ${result.url}`}.`,
      "A published commit is never rewritten in place, and nothing pushes with force.",
    ],
  }),
  "rewrite-tracker-recorded": (result) => ({
    outcome: "conflict",
    reason: "rewrite_tracker_recorded",
    lines: [
      `A tracker step already ran for a result that this move of ${result.branch} takes back to awaiting review: ${result.steps.map((one) => `${one.step} of ${one.assignmentId} (${one.state})`).join(", ")}.`,
      "Its ticket says the work is done while its commit would leave the branch. Bring it to the person. Operator writes no tracker step to undo another one.",
    ],
  }),
  "take-out-pending": (result) => ({
    outcome: "pending",
    reason: "take_out_pending",
    lines: [
      `The integration branch of ${result.sourceId} still holds the withdrawn commit(s) ${result.commits.map((one) => one.commit).join(", ")}.`,
      "Take them out first with `operator work take-out`, as `operator crew next` offers it.",
    ],
  }),
  "landing-tip-changed": (result, command) => ({
    outcome: "conflict",
    reason: "landing_tip_changed",
    lines: [
      `The landing was planned on ${result.planned}, and the recorded tip is now ${result.recordedTip ?? "none"}. ${command.retry === "accept" ? "Accept" : "Delegate the cycle"} again to plan it on the new tip.`,
    ],
  }),
};

function landingWordsOf<S extends keyof LandingByCode>(
  refusal: LandingByCode[S] & { status: S },
  command: LandingCommand,
): Pick<Refusal, "outcome" | "reason" | "lines"> {
  const words: (
    result: LandingByCode[S],
    command: LandingCommand,
  ) => ReturnType<typeof landingWordsOf> = landingWords[refusal.status];
  return words(refusal, command);
}

/**
 * The table entry of the one `landing-refused` variant, keyed on its refusal code. `nothing`
 * names what the command did not do.
 */
export function landingRefusals(command: LandingCommand & { nothing: string }) {
  return {
    "landing-refused": ({ refusal }: { refusal: LandingRefusal }): Refusal => {
      const { outcome, reason, lines } = landingWordsOf(refusal, command);
      const { status: _status, ...detail } = refusal;
      return { outcome, reason, detail, lines: [...lines, command.nothing] };
    },
  };
}

/**
 * Reads a structured request from a file, or from standard input when the path is `-`.
 * A request that cannot be read is reported here, so every command that takes one refuses it
 * the same way and the caller handles only a request it actually holds.
 */
export async function readStructuredInput(request: {
  parsed: ParsedArguments;
  operation: Operation;
  reason: Reason;
  path: string;
}): Promise<{ status: "read"; value: unknown } | { status: "reported" }> {
  const { reason } = request;
  let value: unknown;
  try {
    const text =
      request.path === "-" ? await Bun.stdin.text() : await Bun.file(request.path).text();
    value = JSON.parse(text);
  } catch (error) {
    report({
      json: request.parsed.json,
      result: {
        outcome: "invalid",
        reason,
        blockers: [{ reason, detail: String(error) }],
        operation: request.operation,
      },
      lines: [`The request cannot be read: ${String(error)}`],
    });
    return { status: "reported" };
  }

  return { status: "read", value };
}

/** Reports the reasons one structured request failed its schema. */
export function reportInvalidInput(request: {
  parsed: ParsedArguments;
  operation: Operation;
  reason: Reason;
  issues: string[];
}): Handled {
  answer(
    request.parsed,
    request.operation,
    { status: "invalid-input", issues: request.issues },
    invalidInputRefusals(request.reason),
  );
  return "reported";
}
