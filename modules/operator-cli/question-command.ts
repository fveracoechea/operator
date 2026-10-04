import { CrewState } from "../crew-state/main.ts";
import { type ParsedArguments, readRevision } from "./arguments.ts";
import { invalidInputRefusals, readStructuredInput } from "./crew-result.ts";
import { requireReference } from "./reference.ts";
import { sourceRefusals } from "./source-result.ts";
import {
  answer,
  type Handled,
  type Operation,
  type Outcome,
  type Reason,
  type Refusal,
  refuse,
  report,
} from "./result.ts";

/** One outcome every question command shares. Its blocker and its data carry the whole result. */
function shared<Result extends object>(
  reason: Reason,
  outcome: Outcome,
  lines: (result: Result) => string[],
): (result: Result & { status: string }) => Refusal {
  return (result) => {
    const { status: _status, ...detail } = result;
    return { outcome, reason, lines: lines(result), detail, data: detail };
  };
}

/** The outcomes the question commands share. Each one reports the same way from every command. */
const questionRefusals = {
  "unknown-question": shared("unknown_question", "invalid", (result: { questionId: string }) => [
    `No question is recorded as ${result.questionId}.`,
  ]),
  "stale-question-revision": shared(
    "stale_question_revision",
    "conflict",
    (result: { questionId: string; recordedRevision: number }) => [
      `Question ${result.questionId} is at revision ${result.recordedRevision}.`,
      "Read the question again, then act on the revision you inspected.",
    ],
  ),
  "already-answered": shared(
    "already_answered",
    "conflict",
    (result: { questionId: string; answerId: string }) => [
      `Question ${result.questionId} already holds answer ${result.answerId}.`,
      "One question revision carries one decision.",
    ],
  ),
  "escalation-required": shared(
    "escalation_required",
    "missing-condition",
    (result: { authority: string; escalationTriggers: string[] }) => [
      `This question names subjects a ${result.authority} cannot settle:`,
      ...result.escalationTriggers.map((one) => `  ${one}`),
      "Bring it to the user and record their answer as a human answer.",
    ],
  ),
  "question-closed": shared(
    "question_closed",
    "conflict",
    (result: { questionId: string; state: string }) => [
      `Question ${result.questionId} is ${result.state}, so nothing waits on it.`,
      "Raise a new question instead of changing one the Operative has already acted on.",
    ],
  ),
  // A repeated acknowledgement is completed, so it names no blocker.
  "already-acknowledged": shared(
    "question_already_acknowledged",
    "completed",
    (result: { acknowledgedAt: string }) => [
      `This answer was already acknowledged at ${result.acknowledgedAt}.`,
    ],
  ),
};

/** An owned change of one question with an input file. */
type OwnedQuestionInput = ParsedArguments<
  "--request" | "--owner-token" | "--question" | "--revision" | "--input"
>;

export async function runRaise(
  parsed: ParsedArguments<"--request" | "--attempt" | "--input">,
): Promise<Handled> {
  const { requestId, attemptId, inputPath } = parsed.crew;

  const read = await requireReference({
    parsed,
    operation: "question_raise",
    expectedAttemptId: attemptId,
  });
  if (read.status !== "read") {
    return "reported";
  }

  const input = await readStructuredInput({
    parsed,
    operation: "question_raise",
    reason: "invalid_question_input",
    path: inputPath,
  });
  if (input.status !== "read") {
    return "reported";
  }

  const { result } = await CrewState.raiseQuestion({
    projectRoot: read.reference.controllingCheckout,
    requestId,
    attemptId,
    input: input.value,
  });

  if (
    answer(parsed, "question_raise", result, { ...invalidInputRefusals("invalid_question_input") })
  ) {
    return "reported";
  }

  if (result.status === "question-open") {
    return refuse({
      json: parsed.json,
      operation: "question_raise",
      outcome: "conflict",
      reason: "question_open",
      detail: { questionId: result.questionId, attemptId: result.attemptId, state: result.state },
      lines: [
        `This attempt already waits on question ${result.questionId} (${result.state}).`,
        "Revise that question instead of raising a second one.",
      ],
    });
  }

  report({
    json: parsed.json,
    result: {
      outcome: "pending",
      reason: "question_raised",
      blockers: [{ reason: "question_raised", questionId: result.questionId }],
      operation: "question_raise",
      data: {
        questionId: result.questionId,
        assignmentId: result.assignmentId,
        attemptId: result.attemptId,
        revision: result.revision,
        escalationTriggers: result.escalationTriggers,
        independentWork: result.independentWork,
        repeated: result.repeated,
      },
    },
    lines: [
      `Raised question ${result.questionId} on assignment ${result.assignmentId}.`,
      ...(result.escalationTriggers.length === 0
        ? ["The Operator may answer this inside delegated authority."]
        : [`This question needs the user: ${result.escalationTriggers.join(", ")}.`]),
      ...(result.independentWork.length === 0
        ? ["Nothing continues on this assignment until the answer arrives."]
        : ["Work that continues meanwhile:", ...result.independentWork.map((one) => `  ${one}`)]),
    ],
  });
  return "reported";
}

export async function runRevise(
  parsed: ParsedArguments<"--request" | "--attempt" | "--question" | "--revision" | "--input">,
): Promise<Handled> {
  const { requestId, attemptId, questionId, inputPath } = parsed.crew;
  const revision = readRevision(parsed);
  if (revision === null) {
    return "invalid-arguments";
  }

  const read = await requireReference({
    parsed,
    operation: "question_revise",
    expectedAttemptId: attemptId,
  });
  if (read.status !== "read") {
    return "reported";
  }

  const input = await readStructuredInput({
    parsed,
    operation: "question_revise",
    reason: "invalid_question_input",
    path: inputPath,
  });
  if (input.status !== "read") {
    return "reported";
  }

  const { result } = await CrewState.reviseQuestion({
    projectRoot: read.reference.controllingCheckout,
    requestId,
    attemptId,
    questionId,
    revision,
    input: input.value,
  });

  if (
    answer(parsed, "question_revise", result, {
      ...questionRefusals,
      ...invalidInputRefusals("invalid_question_input"),
    })
  ) {
    return "reported";
  }

  if (result.status === "question-mismatch") {
    return refuse({
      json: parsed.json,
      operation: "question_revise",
      outcome: "conflict",
      reason: "question_mismatch",
      detail: { questionId: result.questionId, attemptId: result.attemptId },
      lines: [`Question ${result.questionId} belongs to attempt ${result.attemptId}.`],
    });
  }

  if (result.status === "delivery-started") {
    return refuse({
      json: parsed.json,
      operation: "question_revise",
      outcome: "conflict",
      reason: "delivery_started",
      detail: { questionId: result.questionId, state: result.state },
      lines: [
        "An answer to this question is already on its way, so the question cannot change now.",
        "Acknowledge the answer, then raise a new question.",
      ],
    });
  }

  report({
    json: parsed.json,
    result: {
      outcome: "pending",
      reason: "question_revised",
      blockers: [{ reason: "question_revised", questionId: result.questionId }],
      operation: "question_revise",
      data: {
        questionId: result.questionId,
        revision: result.revision,
        droppedAnswerId: result.droppedAnswerId,
        escalationTriggers: result.escalationTriggers,
        repeated: result.repeated,
      },
    },
    lines: [
      `Question ${result.questionId} is now at revision ${result.revision}.`,
      ...(result.droppedAnswerId === null
        ? []
        : [
            `Answer ${result.droppedAnswerId} was given to the earlier question.`,
            "It needs an applicability check and an approval before it is used again.",
          ]),
    ],
  });
  return "reported";
}

export async function runEscalate(parsed: OwnedQuestionInput): Promise<Handled> {
  const { requestId, ownerToken, questionId, inputPath } = parsed.crew;
  const revision = readRevision(parsed);
  if (revision === null) {
    return "invalid-arguments";
  }

  const input = await readStructuredInput({
    parsed,
    operation: "question_escalate",
    reason: "invalid_question_input",
    path: inputPath,
  });
  if (input.status !== "read") {
    return "reported";
  }

  const { result } = await CrewState.escalateQuestion({
    projectRoot: process.cwd(),
    requestId,
    ownerToken,
    questionId,
    revision,
    input: input.value,
  });

  if (
    answer(parsed, "question_escalate", result, {
      ...questionRefusals,
      ...invalidInputRefusals("invalid_question_input"),
    })
  ) {
    return "reported";
  }

  if (result.status === "delivery-started") {
    return refuse({
      json: parsed.json,
      operation: "question_escalate",
      outcome: "conflict",
      reason: "delivery_started",
      detail: { questionId: result.questionId, state: result.state },
      lines: [
        "An answer to this question is already on its way, so it is too late to escalate.",
        "Let the Operative acknowledge it, then raise the concern as a new question.",
      ],
    });
  }

  report({
    json: parsed.json,
    result: {
      outcome: "missing-condition",
      reason: "question_escalated",
      blockers: result.escalationTriggers.map((trigger) => ({
        reason: "escalation_required" as const,
        trigger,
        questionId: result.questionId,
      })),
      operation: "question_escalate",
      data: {
        questionId: result.questionId,
        escalationTriggers: result.escalationTriggers,
        droppedAnswerId: result.droppedAnswerId,
        repeated: result.repeated,
      },
    },
    lines: [
      `Question ${result.questionId} now needs the user: ${result.escalationTriggers.join(", ")}.`,
      ...(result.droppedAnswerId === null
        ? []
        : [`Operator decision ${result.droppedAnswerId} no longer applies to it.`]),
      "Bring it to the user and record their answer as a human answer.",
    ],
  });
  return "reported";
}

export async function runAnswer(parsed: OwnedQuestionInput): Promise<Handled> {
  const { requestId, ownerToken, questionId, inputPath } = parsed.crew;
  const revision = readRevision(parsed);
  if (revision === null) {
    return "invalid-arguments";
  }

  const input = await readStructuredInput({
    parsed,
    operation: "question_answer",
    reason: "invalid_answer_input",
    path: inputPath,
  });
  if (input.status !== "read") {
    return "reported";
  }

  const { result } = await CrewState.answerQuestion({
    projectRoot: process.cwd(),
    requestId,
    ownerToken,
    questionId,
    revision,
    input: input.value,
  });

  if (
    answer(parsed, "question_answer", result, {
      ...questionRefusals,
      ...invalidInputRefusals("invalid_answer_input"),
      ...sourceRefusals,
      "unknown-assignment": (refused) => ({
        outcome: "invalid",
        reason: "unknown_assignment",
        detail: { assignmentId: refused.assignmentId },
        lines: [
          `No assignment is registered as ${refused.assignmentId}, so it holds no approved scope.`,
        ],
      }),
    })
  ) {
    return "reported";
  }

  return reportRecordedAnswer(parsed, "question_answer", result);
}

export async function runReapply(
  parsed: ParsedArguments<
    "--request" | "--owner-token" | "--question" | "--revision" | "--answer" | "--approval"
  >,
): Promise<Handled> {
  const { requestId, ownerToken, questionId, answerId, approvalId } = parsed.crew;
  const revision = readRevision(parsed);
  if (revision === null) {
    return "invalid-arguments";
  }

  const { result } = await CrewState.reapplyAnswer({
    projectRoot: process.cwd(),
    requestId,
    ownerToken,
    questionId,
    revision,
    reuseAnswerId: answerId,
    approvalId,
  });

  if (answer(parsed, "question_reapply", result, { ...questionRefusals })) {
    return "reported";
  }

  if (result.status === "unknown-answer") {
    return refuse({
      json: parsed.json,
      operation: "question_reapply",
      outcome: "invalid",
      reason: "unknown_answer",
      detail: { answerId: result.answerId },
      lines: [`This question holds no answer recorded as ${result.answerId}.`],
    });
  }

  if (result.status === "answer-not-earlier") {
    return refuse({
      json: parsed.json,
      operation: "question_reapply",
      outcome: "invalid",
      reason: "answer_not_earlier",
      detail: { answerId: result.answerId, questionRevision: result.questionRevision },
      lines: [
        `Answer ${result.answerId} was recorded for revision ${result.questionRevision}.`,
        "Only an answer from an earlier revision is reused.",
      ],
    });
  }

  return reportRecordedAnswer(parsed, "question_reapply", result);
}

// The answer belongs to the crew state, so this command reads its shape from that interface.
type Recorded = Extract<
  Awaited<ReturnType<typeof CrewState.answerQuestion>>["result"],
  { status: "answered" }
>;

/** Reports a recorded answer. Recording it is not delivery, so the work still waits. */
function reportRecordedAnswer(
  parsed: ParsedArguments,
  operation: Operation,
  result: Recorded,
): Handled {
  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "answer_recorded",
      blockers: [],
      operation,
      data: {
        questionId: result.questionId,
        answerId: result.answerId,
        authority: result.authority,
        questionRevision: result.questionRevision,
        reusedFromId: result.reusedFromId,
        approvalId: result.approvalId,
        repeated: result.repeated,
      },
    },
    lines: [
      `Recorded answer ${result.answerId} (${result.authority}) for question ${result.questionId}.`,
      ...(result.reusedFromId === null
        ? []
        : [`It reuses answer ${result.reusedFromId} under approval ${String(result.approvalId)}.`]),
      "The Operative stays blocked until the answer is delivered and acknowledged.",
    ],
  });
  return "reported";
}

export async function runDeliver(
  parsed: ParsedArguments<"--request" | "--owner-token" | "--question">,
): Promise<Handled> {
  const { requestId, ownerToken, questionId } = parsed.crew;

  const { result } = await CrewState.deliverAnswer({
    projectRoot: process.cwd(),
    requestId,
    ownerToken,
    questionId,
  });

  if (answer(parsed, "question_deliver", result, { ...questionRefusals })) {
    return "reported";
  }

  if (result.status === "not-answered") {
    return refuse({
      json: parsed.json,
      operation: "question_deliver",
      outcome: "missing-condition",
      reason: "answer_missing",
      detail: { questionId: result.questionId, state: result.state },
      lines: [`Question ${result.questionId} holds no answer to deliver.`],
    });
  }

  if (result.status === "reconciliation-required") {
    return refuse({
      json: parsed.json,
      operation: "question_deliver",
      outcome: "missing-condition",
      reason: "reconciliation_required",
      detail: { questionId: result.questionId, operationState: result.operationState },
      lines: [
        `The delivery of this answer is ${result.operationState}, so it may already have arrived.`,
        "Run `operator attempt reconcile` before another delivery.",
      ],
    });
  }

  if (result.status === "delivery-failed" || result.status === "delivery-uncertain") {
    const uncertain = result.status === "delivery-uncertain";
    report({
      json: parsed.json,
      result: {
        outcome: uncertain ? "uncertain" : "failed",
        reason: uncertain ? "delivery_uncertain" : "delivery_failed",
        blockers: [
          {
            reason: uncertain ? "delivery_uncertain" : "delivery_failed",
            questionId: result.questionId,
            detail: result.detail,
          },
        ],
        operation: "question_deliver",
      },
      lines: [
        `The answer delivery ${uncertain ? "did not answer" : "failed"}: ${result.detail}`,
        ...(uncertain
          ? ["A timeout does not prove non-delivery. Reconcile before you deliver again."]
          : []),
      ],
    });
    return "reported";
  }

  report({
    json: parsed.json,
    result: {
      outcome: "pending",
      reason: "answer_delivered",
      blockers: [{ reason: "answer_delivered", questionId: result.questionId }],
      operation: "question_deliver",
      data: {
        questionId: result.questionId,
        answerId: result.answerId,
        attemptId: result.attemptId,
        agentName: result.agentName,
        deliveredAt: result.deliveredAt,
        repeated: result.repeated,
      },
    },
    lines: [
      `Submitted answer ${result.answerId} to ${result.agentName}.`,
      "This work stays blocked until the Operative acknowledges the answer.",
    ],
  });
  return "reported";
}

export async function runAcknowledge(
  parsed: ParsedArguments<"--request" | "--question">,
): Promise<Handled> {
  const { requestId, questionId } = parsed.crew;

  const read = await requireReference({
    parsed,
    operation: "question_acknowledge",
    expectedAttemptId: null,
  });
  if (read.status !== "read") {
    return "reported";
  }

  const { result } = await CrewState.acknowledgeAnswer({
    projectRoot: read.reference.controllingCheckout,
    requestId,
    questionId,
    worktreePath: read.reference.worktreePath,
  });

  if (answer(parsed, "question_acknowledge", result, { ...questionRefusals })) {
    return "reported";
  }

  if (result.status === "not-delivered") {
    return refuse({
      json: parsed.json,
      operation: "question_acknowledge",
      outcome: "missing-condition",
      reason: "question_not_delivered",
      detail: { questionId: result.questionId, state: result.state },
      lines: [`No answer to question ${result.questionId} has been sent yet.`],
    });
  }

  if (result.status === "reference-mismatch") {
    return refuse({
      json: parsed.json,
      operation: "question_acknowledge",
      outcome: "conflict",
      reason: "question_reference_mismatch",
      detail: { questionId: result.questionId, detail: result.detail },
      lines: [result.detail],
    });
  }

  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "question_acknowledged",
      blockers: [],
      operation: "question_acknowledge",
      data: {
        questionId: result.questionId,
        assignmentId: result.assignmentId,
        attemptId: result.attemptId,
        repeated: result.repeated,
      },
    },
    lines: [
      `Acknowledged the answer to question ${result.questionId}.`,
      "This assignment is no longer blocked by that question.",
    ],
  });
  return "reported";
}

export async function runShow(parsed: ParsedArguments<"--question">): Promise<Handled> {
  const questionId = parsed.crew.questionId;

  const { result } = await CrewState.question({ projectRoot: process.cwd(), questionId });
  if (answer(parsed, "question_show", result, { ...questionRefusals })) {
    return "reported";
  }

  const question = result.question;
  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "question_reported",
      blockers: [],
      operation: "question_show",
      data: question,
    },
    lines: [
      `Question ${question.questionId} revision ${question.revision} is ${question.state}.`,
      `Assignment ${question.assignmentId}, attempt ${question.attemptId}.`,
      question.report.question,
      `Affected scope: ${question.report.affectedScope.join(", ")}.`,
      ...(question.escalationTriggers.length === 0
        ? []
        : [`Needs the user: ${question.escalationTriggers.join(", ")}.`]),
      ...(question.answer === null
        ? ["No answer applies to this revision."]
        : [
            `Answer ${question.answer.answerId} (${question.answer.authority}).`,
            ...(question.answer.exactText === null
              ? []
              : ["Exact words:", question.answer.exactText]),
          ]),
    ],
  });
  return "reported";
}
