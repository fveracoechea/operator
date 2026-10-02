import { CrewState } from "../crew-state/main.ts";
import { type ParsedArguments } from "./arguments.ts";
import { readStructuredInput, reportInvalidInput, reportSharedFailure } from "./crew-result.ts";
import { type Handled, report } from "./result.ts";

/**
 * Records what the Operator decided about each outside change of one submission.
 * The command never deletes a file: the user does, and a new scan proves the removal.
 */
export async function runDispose(parsed: ParsedArguments): Promise<Handled> {
  const { requestId, ownerToken, submissionId, inputPath } = parsed.crew;
  if (
    requestId === undefined ||
    ownerToken === undefined ||
    submissionId === undefined ||
    inputPath === undefined
  ) {
    return "invalid-arguments";
  }

  const read = await readStructuredInput({
    parsed,
    operation: "work_dispose",
    reason: "invalid_outside_disposition_input",
    path: inputPath,
  });
  if (read.status !== "read") {
    return "reported";
  }

  const { repeated, result } = await CrewState.disposeOutside({
    projectRoot: process.cwd(),
    requestId,
    ownerToken,
    submissionId,
    input: read.value,
  });

  if (reportSharedFailure(parsed, "work_dispose", result)) {
    return "reported";
  }

  if (result.status === "invalid-input") {
    return reportInvalidInput({
      parsed,
      operation: "work_dispose",
      reason: "invalid_outside_disposition_input",
      issues: result.issues,
    });
  }

  if (result.status === "unknown-submission") {
    report({
      json: parsed.json,
      result: {
        outcome: "invalid",
        reason: "unknown_submission",
        blockers: [{ reason: "unknown_submission", submissionId: result.submissionId }],
        operation: "work_dispose",
      },
      lines: [`The crew state holds no submission ${result.submissionId}.`],
    });
    return "reported";
  }

  if (result.status === "submission-settled") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "submission_settled",
        blockers: [
          { reason: "submission_settled", submissionId: result.submissionId, state: result.state },
        ],
        operation: "work_dispose",
      },
      lines: [`Submission ${result.submissionId} is ${result.state}, so its record is fixed.`],
    });
    return "reported";
  }

  if (result.status === "unknown-outside-change") {
    report({
      json: parsed.json,
      result: {
        outcome: "invalid",
        reason: "unknown_outside_change",
        blockers: result.changeIds.map((changeId) => ({
          reason: "unknown_outside_change" as const,
          changeId,
        })),
        operation: "work_dispose",
      },
      lines: [`Submission ${result.submissionId} holds no such outside change(s).`],
    });
    return "reported";
  }

  if (result.status === "outside-dispose-refused") {
    const blockers = [
      ...result.notRemoved.map((one) => ({
        reason: "outside_change_not_removed" as const,
        ...one,
      })),
      ...result.approvalMissing.map((one) => ({
        reason: "outside_change_approval_missing" as const,
        ...one,
      })),
    ];
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: blockers[0]?.reason ?? "outside_change_not_removed",
        blockers,
        operation: "work_dispose",
      },
      lines: [
        "Nothing was recorded.",
        ...(result.notRemoved.length === 0
          ? []
          : [
              `A new scan still finds ${result.notRemoved.length} outside change(s) that you marked removed.`,
              "Operator never deletes one. Ask the user to delete it, then dispose it again.",
            ]),
        ...(result.approvalMissing.length === 0
          ? []
          : [
              `${result.approvalMissing.length} outside change(s) touch a security permission.`,
              "Ask the user. Only their approval of the exact path keeps such a change.",
            ]),
      ],
    });
    return "reported";
  }

  report({
    json: parsed.json,
    result: {
      outcome: result.outstanding.length === 0 ? "completed" : "pending",
      reason: "outside_changes_disposed",
      blockers: result.outstanding.map((changeId) => ({
        reason: "outside_changes_undisposed" as const,
        changeId,
      })),
      operation: "work_dispose",
      data: {
        submissionId: result.submissionId,
        disposed: result.disposed,
        outstanding: result.outstanding,
        repeated,
      },
    },
    lines: [
      `Recorded ${result.disposed.length} disposition(s) on submission ${result.submissionId}.`,
      result.outstanding.length === 0
        ? "Every outside change now carries a disposition."
        : `${result.outstanding.length} outside change(s) still carry none.`,
    ],
  });
  return "reported";
}
