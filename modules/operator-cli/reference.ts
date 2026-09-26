import { OperativeDispatch } from "../operative-dispatch/main.ts";
import type { ParsedArguments } from "./arguments.ts";
import { type Operation, report } from "./result.ts";

type Reference = NonNullable<Awaited<ReturnType<typeof OperativeDispatch.readReference>>>;

export type ReferenceRead = { status: "read"; reference: Reference } | { status: "reported" };

/**
 * Reads the control reference of the worktree this command runs in.
 * An Operative names its own attempt through that file, so it never searches nearby directories
 * for the crew state that governs it, and it cannot report against another attempt.
 */
export async function requireReference(request: {
  parsed: ParsedArguments;
  operation: Operation;
  expectedAttemptId: string | null;
}): Promise<ReferenceRead> {
  const { parsed, operation } = request;
  const reference = await OperativeDispatch.readReference({ worktreePath: process.cwd() });
  if (reference === null) {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "attempt_reference_missing",
        blockers: [{ reason: "attempt_reference_missing", attemptId: request.expectedAttemptId }],
        operation,
      },
      lines: [
        "This directory carries no Operator attempt reference.",
        "Run this from the worktree the Operator prepared for this attempt.",
      ],
    });
    return { status: "reported" };
  }

  if (request.expectedAttemptId !== null && reference.attemptId !== request.expectedAttemptId) {
    report({
      json: parsed.json,
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
        operation,
      },
      lines: [`This worktree belongs to attempt ${reference.attemptId}.`],
    });
    return { status: "reported" };
  }

  return { status: "read", reference };
}
