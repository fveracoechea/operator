import type { ParsedArguments } from "./arguments.ts";
import type { Operation } from "./result.ts";
import { type Handled, type Reason, refuse, report } from "./result.ts";

type SharedReport = {
  reason: Reason;
  outcome: "failed" | "invalid" | "missing-condition" | "conflict";
  line: string;
};

const sharedFailures = {
  "state-missing": {
    reason: "state_missing",
    outcome: "missing-condition",
    line: "This project holds no crew state. Run `operator crew own` to start a crew.",
  },
  "state-unreadable": {
    reason: "unreadable_state",
    outcome: "conflict",
    line: "The crew state cannot be read. Nothing was dispatched and nothing was replaced.",
  },
  "state-unsupported": {
    reason: "state_version_unsupported",
    outcome: "failed",
    line: "The crew state was written by a newer Operator release. Update Operator to read it.",
  },
  "request-input-changed": {
    reason: "request_input_changed",
    outcome: "invalid",
    line: "This request identity already recorded different input. Use a new request identity.",
  },
  unowned: {
    reason: "crew_unowned",
    outcome: "missing-condition",
    line: "No Operator owns this crew. Run `operator crew own` first.",
  },
  "ownership-stale": {
    reason: "ownership_stale",
    outcome: "conflict",
    line: "Another Operator took ownership of this crew. This token can no longer change state.",
  },
  "unknown-attempt": {
    reason: "unknown_attempt",
    outcome: "invalid",
    line: "No attempt is recorded under that identity.",
  },
  "attempt-ended": {
    reason: "attempt_ended",
    outcome: "conflict",
    line: "That attempt has ended, so it can no longer write. Claim the assignment again.",
  },
  "attempt-not-current": {
    reason: "attempt_not_current",
    outcome: "conflict",
    line: "Another Operator owns this crew, so this attempt is not the current writer.",
  },
  "not-dispatched": {
    reason: "attempt_not_dispatched",
    outcome: "missing-condition",
    line: "That attempt has no recorded launch. Dispatch it first.",
  },
  "not-acknowledged": {
    reason: "attempt_not_acknowledged",
    outcome: "missing-condition",
    line: "That attempt never acknowledged its brief, so it has nothing fixed to hand over.",
  },
  "unknown-review": {
    reason: "unknown_review",
    outcome: "invalid",
    line: "No review is recorded under that identity.",
  },
  "invalid-configuration": {
    reason: "invalid_configuration",
    outcome: "invalid",
    line: "The Operator configuration is not valid, so the crew size is unknown.",
  },
} satisfies Record<string, SharedReport>;

/** The statuses this reporter owns. A crew-state result carrying any other is the command's. */
type SharedStatus = keyof typeof sharedFailures;

const failureByStatus: Record<string, SharedReport | undefined> = sharedFailures;

/**
 * Reports the outcomes every crew-state call shares: a state file that cannot serve a request,
 * a reused request identity carrying different input, and a missing or replaced ownership token.
 * Returns true when it reported, so each command handles only its own outcomes.
 */
export function reportSharedFailure<Result extends { status: string }>(
  parsed: ParsedArguments,
  operation: Operation,
  result: Result,
): result is Extract<Result, { status: SharedStatus }> {
  const failure = failureByStatus[result.status];
  if (failure === undefined) {
    return false;
  }

  const { status: _status, ...detail } = result;
  report({
    json: parsed.json,
    result: {
      outcome: failure.outcome,
      reason: failure.reason,
      blockers: [{ reason: failure.reason, ...detail }],
      operation,
    },
    lines: [failure.line],
  });
  return true;
}

type AssignmentFailure =
  | { status: "unknown-assignment"; assignmentId: string }
  | { status: "stale-revision"; assignmentId: string; recordedRevision: number };

/**
 * Reports the two refusals every command that names one inspected assignment shares.
 * Returns true when it reported, so each command handles only its own outcomes.
 */
export function reportAssignmentFailure<Result extends { status: string }>(
  parsed: ParsedArguments,
  operation: Operation,
  result: Result,
): result is Extract<Result, AssignmentFailure> {
  if (result.status === "unknown-assignment" && "assignmentId" in result) {
    refuse({
      json: parsed.json,
      operation,
      outcome: "invalid",
      reason: "unknown_assignment",
      detail: { assignmentId: result.assignmentId },
      lines: [`No assignment is registered as ${String(result.assignmentId)}.`],
    });
    return true;
  }

  if (result.status === "stale-revision" && "assignmentId" in result) {
    const recorded = "recordedRevision" in result ? result.recordedRevision : null;
    refuse({
      json: parsed.json,
      operation,
      outcome: "conflict",
      reason: "stale_revision",
      detail: { assignmentId: result.assignmentId, recordedRevision: recorded },
      lines: [
        `Assignment ${String(result.assignmentId)} is at revision ${String(recorded)}.`,
        "Read it again, then state the revision you inspected.",
      ],
    });
    return true;
  }

  return false;
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
  const { reason } = request;
  report({
    json: request.parsed.json,
    result: {
      outcome: "invalid",
      reason,
      blockers: request.issues.map((issue) => ({ reason, issue })),
      operation: request.operation,
    },
    lines: ["The request is not valid:", ...request.issues.map((one) => `  ${one}`)],
  });
  return "reported";
}
