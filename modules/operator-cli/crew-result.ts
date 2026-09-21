import type { ParsedArguments } from "./arguments.ts";
import { type Reason, report } from "./result.ts";

type Operation = "crew_own" | "work_register" | "work_claim" | "work_accept" | "work_frontier";

type Shared = { status: string } & Record<string, unknown>;

/**
 * Reports the outcomes every crew-state call shares: a state file that cannot serve a request,
 * a reused request identity carrying different input, and a missing or replaced ownership token.
 * Returns true when it reported, so each command handles only its own outcomes.
 */
export function reportSharedFailure(
  parsed: ParsedArguments,
  operation: Operation,
  result: Shared,
): boolean {
  const failures: Record<
    string,
    {
      reason: Reason;
      outcome: "failed" | "invalid" | "missing-condition" | "conflict";
      line: string;
    }
  > = {
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
    "invalid-configuration": {
      reason: "invalid_configuration",
      outcome: "invalid",
      line: "The Operator configuration is not valid, so the crew size is unknown.",
    },
  };

  const failure = failures[result.status];
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
