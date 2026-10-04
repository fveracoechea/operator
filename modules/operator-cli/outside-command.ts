import { CrewState } from "../crew-state/main.ts";
import { type ParsedArguments } from "./arguments.ts";
import { invalidInputRefusals, readStructuredInput } from "./crew-result.ts";
import { answer, countedBlockers, type Handled, type Refusals, report } from "./result.ts";

type DisposeResult = Awaited<ReturnType<typeof CrewState.disposeOutside>>["result"];

/**
 * The answers of `work dispose` to every status that records no disposition. A refusal that
 * names outside changes counts them in its blockers and keeps them in `data` (R5).
 */
const disposeRefusals = {
  ...invalidInputRefusals("invalid_outside_disposition_input"),
  "unknown-submission": (result) => ({
    outcome: "invalid",
    reason: "unknown_submission",
    detail: { submissionId: result.submissionId },
    lines: [`The crew state holds no submission ${result.submissionId}.`],
  }),
  "submission-settled": (result) => ({
    outcome: "conflict",
    reason: "submission_settled",
    detail: { submissionId: result.submissionId, state: result.state },
    lines: [`Submission ${result.submissionId} is ${result.state}, so its record is fixed.`],
  }),
  "unknown-outside-change": (result) => ({
    outcome: "invalid",
    reason: "unknown_outside_change",
    blockers: countedBlockers("unknown_outside_change", result.changeIds),
    data: { submissionId: result.submissionId, changeIds: result.changeIds },
    lines: [`Submission ${result.submissionId} holds no such outside change(s).`],
  }),
  "outside-dispose-refused": (result) => {
    const blockers = [
      ...countedBlockers("outside_change_not_removed", result.notRemoved),
      ...countedBlockers("outside_change_approval_missing", result.approvalMissing),
    ];
    return {
      outcome: "missing-condition",
      reason: blockers[0]?.reason ?? "outside_change_not_removed",
      blockers,
      data: {
        submissionId: result.submissionId,
        notRemoved: result.notRemoved,
        approvalMissing: result.approvalMissing,
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
        "Read each change with `operator review show --review <id> --json`.",
      ],
    };
  },
} satisfies Refusals<DisposeResult>;

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

  if (answer(parsed, "work_dispose", result, disposeRefusals)) {
    return "reported";
  }

  report({
    json: parsed.json,
    result: {
      outcome: result.outstanding.length === 0 ? "completed" : "pending",
      reason: "outside_changes_disposed",
      blockers: countedBlockers("outside_changes_undisposed", result.outstanding),
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
