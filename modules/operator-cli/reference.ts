import { CrewState } from "../crew-state/main.ts";
import { OperativeDispatch } from "../operative-dispatch/main.ts";
import type { ParsedArguments } from "./arguments.ts";
import { type Operation, report } from "./result.ts";

type Inspected = Awaited<ReturnType<typeof OperativeDispatch.inspectReference>>;

export type ReferenceRead = Extract<Inspected, { status: "read" }> | { status: "reported" };

const PROBLEM_LINES = {
  unreadable: "Its control reference is not a file this command can read.",
  "not-json": "Its control reference is not valid JSON.",
  "not-object": "Its control reference is not a JSON object.",
  incomplete: "Its control reference is not complete.",
} as const;

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
  const inspected = await OperativeDispatch.inspectReference({ worktreePath: process.cwd() });
  if (inspected.status === "missing") {
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

  // The file is there, so the command runs in the right place and the file itself changed.
  if (inspected.status === "malformed") {
    report({
      json: parsed.json,
      result: {
        outcome: "invalid",
        reason: "attempt_reference_malformed",
        blockers: [
          {
            reason: "attempt_reference_malformed",
            attemptId: request.expectedAttemptId,
            problem: inspected.problem,
            fields: inspected.fields,
          },
        ],
        operation,
      },
      lines: [
        `This worktree carries an Operator attempt reference that this command cannot use. ${PROBLEM_LINES[inspected.problem]}`,
        ...(inspected.fields.length > 0
          ? [`It has no usable value for: ${inspected.fields.join(", ")}.`]
          : []),
        "Ask the Operator to repair this worktree. Do not repair the file yourself.",
      ],
    });
    return { status: "reported" };
  }

  const reference = inspected.reference;
  const checked = CrewState.checkReference({
    attemptId: request.expectedAttemptId,
    referencedAttemptId: reference.attemptId,
  });
  if (checked.status === "attempt-reference-mismatch") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "attempt_reference_mismatch",
        blockers: [
          {
            reason: "attempt_reference_mismatch",
            attemptId: checked.attemptId,
            recordedAttemptId: checked.recordedAttemptId,
          },
        ],
        operation,
      },
      lines: [`This worktree belongs to attempt ${checked.recordedAttemptId}.`],
    });
    return { status: "reported" };
  }

  return { status: "read", reference };
}
