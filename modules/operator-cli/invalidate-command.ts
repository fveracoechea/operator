import { CrewState } from "../crew-state/main.ts";
import { type ParsedArguments, readAssignmentRequest } from "./arguments.ts";
import { assignmentRefusals, readStructuredInput, reportInvalidInput } from "./crew-result.ts";
import { answer, type Handled, refuse, report } from "./result.ts";

export async function runInvalidate(
  parsed: ParsedArguments<
    "--request" | "--owner-token" | "--assignment" | "--revision" | "--input"
  >,
): Promise<Handled> {
  const request = readAssignmentRequest(parsed);
  if (request === null) {
    return "invalid-arguments";
  }

  const read = await readStructuredInput({
    parsed,
    operation: "work_invalidate",
    reason: "invalid_defect_input",
    path: request.inputPath,
  });
  if (read.status !== "read") {
    return "reported";
  }

  const { repeated, result } = await CrewState.invalidate({
    projectRoot: process.cwd(),
    requestId: request.requestId,
    ownerToken: request.ownerToken,
    assignmentId: request.assignmentId,
    revision: request.revision,
    input: read.value,
  });

  if (answer(parsed, "work_invalidate", result, assignmentRefusals)) {
    return "reported";
  }

  if (result.status === "invalid-input") {
    return reportInvalidInput({
      parsed,
      operation: "work_invalidate",
      reason: "invalid_defect_input",
      issues: result.issues,
    });
  }

  if (result.status === "review-not-invalidated") {
    return refuse({
      json: parsed.json,
      operation: "work_invalidate",
      outcome: "invalid",
      reason: "review_not_invalidated",
      detail: { assignmentId: result.assignmentId },
      lines: [
        `Assignment ${result.assignmentId} is review work, which holds no result of its own.`,
        "A review that read the work wrongly is answered by reviewing that work again.",
      ],
    });
  }

  if (result.status === "merged") {
    return refuse({
      json: parsed.json,
      operation: "work_invalidate",
      outcome: "conflict",
      reason: "invalidation_merged",
      detail: { ...result },
      lines: [
        `The commit ${result.commit} of assignment ${result.assignmentId} merged into the target in pull request ${result.pullRequest ?? "(number not recorded)"}.`,
        "A merged commit is never invalidated or taken out. The defect becomes a new issue, which a person creates.",
      ],
    });
  }

  if (result.status === "not-accepted") {
    return refuse({
      json: parsed.json,
      operation: "work_invalidate",
      outcome: "conflict",
      reason: "assignment_not_accepted",
      detail: { assignmentId: result.assignmentId, state: result.state },
      lines: [
        `Assignment ${result.assignmentId} is ${result.state}, so it holds no accepted result.`,
        "Unaccepted work is corrected through a rework cycle instead.",
      ],
    });
  }

  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "result_invalidated",
      blockers: [],
      operation: "work_invalidate",
      data: {
        assignmentId: result.assignmentId,
        revision: result.revision,
        invalidationId: result.invalidationId,
        submissionId: result.submissionId,
        dependents: result.dependents,
        cycle: result.cycle,
        direction: result.direction,
        repeated,
      },
    },
    lines: [
      `Recorded defect ${result.invalidationId} against ${result.assignmentId}.`,
      "Its acceptance, submission, review, and findings stay recorded.",
      ...(result.cycle !== null
        ? [
            `Opened invalidation cycle ${result.cycle.cycleId} (${result.cycle.cycleIndex} of ${result.cycle.limit}). Its brief carries the defect.`,
            ...(result.cycle.startCommit === null
              ? []
              : [
                  `Its dispatch starts on ${result.cycle.startCommit}, the parent of landed commit ${result.cycle.landedCommit}.`,
                ]),
          ]
        : result.direction !== null
          ? [
              `The correction budget is spent, so direction request ${result.direction.directionRequestId} waits on the user.`,
              "The frontier withholds the dispatch with direction_required until the user answers.",
            ]
          : ["Planning work opens no cycle. It is decided again with a new planning record."]),
      ...(result.dependents.length === 0
        ? ["No dependent consumed the result, so nothing was paused."]
        : [
            `${result.dependents.length} dependent(s) read it and are paused:`,
            ...result.dependents.map((one) => `  ${one.assignmentId} was ${one.consumedState}`),
          ]),
      "A dependent that never started is held by the dependency gate, not paused.",
    ],
  });
  return "reported";
}
