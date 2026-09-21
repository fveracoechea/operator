import { OperativeDispatch } from "../operative-dispatch/main.ts";
import type { ParsedArguments } from "./arguments.ts";
import { type Reason, report } from "./result.ts";

type AttemptReference = NonNullable<Awaited<ReturnType<typeof OperativeDispatch.readReference>>>;

type Operation =
  | "crew_own"
  | "work_register"
  | "work_claim"
  | "work_accept"
  | "work_frontier"
  | "attempt_dispatch"
  | "attempt_acknowledge"
  | "attempt_reconcile"
  | "attempt_replace"
  | "attempt_show"
  | "attempt_submit"
  | "review_report"
  | "review_dispose"
  | "review_show";

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

/** Reads a structured request from a file, or from standard input when the path is `-`. */
export async function readStructuredInput(
  path: string,
): Promise<{ ok: true; value: unknown } | { ok: false; detail: string }> {
  try {
    const text = path === "-" ? await Bun.stdin.text() : await Bun.file(path).text();
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, detail: String(error) };
  }
}

/**
 * Reads the control reference of the worktree a command runs in.
 * An Operative and a reviewer both report from their own checkout, so the reference is what
 * names the attempt rather than a directory search.
 */
export async function readWorktreeReference(request: {
  parsed: ParsedArguments;
  operation: Operation;
  expectedAttemptId: string | null;
}): Promise<AttemptReference | null> {
  const reference = await OperativeDispatch.readReference({ worktreePath: process.cwd() });
  if (reference === null) {
    report({
      json: request.parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "attempt_reference_missing",
        blockers: [{ reason: "attempt_reference_missing", attemptId: request.expectedAttemptId }],
        operation: request.operation,
      },
      lines: [
        "This directory carries no Operator attempt reference.",
        "Run this from the worktree the Operator prepared for this attempt.",
      ],
    });
    return null;
  }

  if (request.expectedAttemptId !== null && reference.attemptId !== request.expectedAttemptId) {
    report({
      json: request.parsed.json,
      result: {
        outcome: "conflict",
        reason: "attempt_reference_mismatch",
        blockers: [
          {
            reason: "attempt_reference_mismatch",
            attemptId: request.expectedAttemptId,
            recordedAttemptId: reference.attemptId,
          },
        ],
        operation: request.operation,
      },
      lines: [`This worktree belongs to attempt ${reference.attemptId}.`],
    });
    return null;
  }

  return reference;
}
