import { CrewState } from "../crew-state/main.ts";
import type { ParsedArguments } from "./arguments.ts";
import { readStructuredInput, reportSharedFailure } from "./crew-result.ts";
import { requireReference } from "./reference.ts";
import { type Handled, type Operation, type Reason, report } from "./result.ts";

function readRevision(parsed: ParsedArguments): number | null {
  const raw = parsed.crew.revision;
  return raw === undefined || !/^\d+$/.test(raw) ? null : Number(raw);
}

/** Reports a structured request that could not be read from its file or from standard input. */
function reportUnreadable(
  parsed: ParsedArguments,
  operation: Operation,
  reason: Reason,
  detail: string,
): Handled {
  report({
    json: parsed.json,
    result: {
      outcome: "invalid",
      reason,
      blockers: [{ reason, detail }],
      operation,
    },
    lines: [`The request cannot be read: ${detail}`],
  });
  return "reported";
}

function reportIssues(
  parsed: ParsedArguments,
  operation: Operation,
  reason: Reason,
  issues: string[],
): Handled {
  report({
    json: parsed.json,
    result: {
      outcome: "invalid",
      reason,
      blockers: issues.map((issue) => ({ reason, issue })),
      operation,
    },
    lines: ["The request is not valid:", ...issues.map((one) => `  ${one}`)],
  });
  return "reported";
}

type QuestionOutcome = {
  reason: Reason;
  outcome: "completed" | "invalid" | "missing-condition" | "conflict";
  lines: (detail: Record<string, unknown>) => string[];
};

function textList(detail: Record<string, unknown>, key: string): string[] {
  const value = detail[key];
  return Array.isArray(value) ? value.map(String) : [];
}

/** The outcomes the question commands share. Each one reports the same way from every command. */
const questionOutcomes = {
  "unknown-question": {
    reason: "unknown_question",
    outcome: "invalid",
    lines: (detail) => [`No question is recorded as ${String(detail.questionId)}.`],
  },
  "stale-question-revision": {
    reason: "stale_question_revision",
    outcome: "conflict",
    lines: (detail) => [
      `Question ${String(detail.questionId)} is at revision ${String(detail.recordedRevision)}.`,
      "Read the question again, then act on the revision you inspected.",
    ],
  },
  "already-answered": {
    reason: "already_answered",
    outcome: "conflict",
    lines: (detail) => [
      `Question ${String(detail.questionId)} already holds answer ${String(detail.answerId)}.`,
      "One question revision carries one decision.",
    ],
  },
  "escalation-required": {
    reason: "escalation_required",
    outcome: "missing-condition",
    lines: (detail) => [
      `This question names subjects a ${String(detail.authority)} cannot settle:`,
      ...textList(detail, "escalationTriggers").map((one) => `  ${one}`),
      "Bring it to the user and record their answer as a human answer.",
    ],
  },
  "question-closed": {
    reason: "question_closed",
    outcome: "conflict",
    lines: (detail) => [
      `Question ${String(detail.questionId)} is ${String(detail.state)}, so nothing waits on it.`,
      "Raise a new question instead of changing one the Operative has already acted on.",
    ],
  },
  "already-acknowledged": {
    reason: "question_already_acknowledged",
    outcome: "completed",
    lines: (detail) => [
      `This answer was already acknowledged at ${String(detail.acknowledgedAt)}.`,
    ],
  },
} satisfies Record<string, QuestionOutcome>;

type SharedQuestionStatus = keyof typeof questionOutcomes;

const outcomeByStatus: Record<string, QuestionOutcome | undefined> = questionOutcomes;

/** Returns true when it reported, so each command handles only its own outcomes. */
function reportQuestionOutcome<Result extends { status: string }>(
  parsed: ParsedArguments,
  operation: Operation,
  result: Result,
): result is Extract<Result, { status: SharedQuestionStatus }> {
  const shared = outcomeByStatus[result.status];
  if (shared === undefined) {
    return false;
  }

  const { status: _status, ...detail } = result;
  report({
    json: parsed.json,
    result: {
      outcome: shared.outcome,
      reason: shared.reason,
      // A completed outcome names no blocker, so only a refusal carries one.
      blockers: shared.outcome === "completed" ? [] : [{ reason: shared.reason, ...detail }],
      operation,
      data: detail,
    },
    lines: shared.lines(detail),
  });
  return true;
}

async function runRaise(parsed: ParsedArguments): Promise<Handled> {
  const { requestId, attemptId, inputPath } = parsed.crew;
  if (requestId === undefined || attemptId === undefined || inputPath === undefined) {
    return "invalid-arguments";
  }

  const read = await requireReference({
    parsed,
    operation: "question_raise",
    expectedAttemptId: attemptId,
  });
  if (read.status !== "read") {
    return "reported";
  }

  const input = await readStructuredInput(inputPath);
  if (!input.ok) {
    return reportUnreadable(parsed, "question_raise", "invalid_question_input", input.detail);
  }

  const { result } = await CrewState.raiseQuestion({
    projectRoot: read.reference.controllingCheckout,
    requestId,
    attemptId,
    input: input.value,
  });

  if (reportSharedFailure(parsed, "question_raise", result)) {
    return "reported";
  }
  if (result.status === "invalid-input") {
    return reportIssues(parsed, "question_raise", "invalid_question_input", result.issues);
  }

  if (result.status === "question-open") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "question_open",
        blockers: [
          {
            reason: "question_open",
            questionId: result.questionId,
            attemptId: result.attemptId,
            state: result.state,
          },
        ],
        operation: "question_raise",
      },
      lines: [
        `This attempt already waits on question ${result.questionId} (${result.state}).`,
        "Revise that question instead of raising a second one.",
      ],
    });
    return "reported";
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

async function runRevise(parsed: ParsedArguments): Promise<Handled> {
  const { requestId, attemptId, questionId, inputPath } = parsed.crew;
  const revision = readRevision(parsed);
  if (
    requestId === undefined ||
    attemptId === undefined ||
    questionId === undefined ||
    inputPath === undefined ||
    revision === null
  ) {
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

  const input = await readStructuredInput(inputPath);
  if (!input.ok) {
    return reportUnreadable(parsed, "question_revise", "invalid_question_input", input.detail);
  }

  const { result } = await CrewState.reviseQuestion({
    projectRoot: read.reference.controllingCheckout,
    requestId,
    attemptId,
    questionId,
    revision,
    input: input.value,
  });

  if (reportSharedFailure(parsed, "question_revise", result)) {
    return "reported";
  }
  if (result.status === "invalid-input") {
    return reportIssues(parsed, "question_revise", "invalid_question_input", result.issues);
  }
  if (reportQuestionOutcome(parsed, "question_revise", result)) {
    return "reported";
  }

  if (result.status === "question-mismatch") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "question_mismatch",
        blockers: [
          {
            reason: "question_mismatch",
            questionId: result.questionId,
            attemptId: result.attemptId,
          },
        ],
        operation: "question_revise",
      },
      lines: [`Question ${result.questionId} belongs to attempt ${result.attemptId}.`],
    });
    return "reported";
  }

  if (result.status === "delivery-started") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "delivery_started",
        blockers: [
          { reason: "delivery_started", questionId: result.questionId, state: result.state },
        ],
        operation: "question_revise",
      },
      lines: [
        "An answer to this question is already on its way, so the question cannot change now.",
        "Acknowledge the answer, then raise a new question.",
      ],
    });
    return "reported";
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

async function runEscalate(parsed: ParsedArguments): Promise<Handled> {
  const { requestId, ownerToken, questionId, inputPath } = parsed.crew;
  const revision = readRevision(parsed);
  if (
    requestId === undefined ||
    ownerToken === undefined ||
    questionId === undefined ||
    inputPath === undefined ||
    revision === null
  ) {
    return "invalid-arguments";
  }

  const input = await readStructuredInput(inputPath);
  if (!input.ok) {
    return reportUnreadable(parsed, "question_escalate", "invalid_question_input", input.detail);
  }

  const { result } = await CrewState.escalateQuestion({
    projectRoot: process.cwd(),
    requestId,
    ownerToken,
    questionId,
    revision,
    input: input.value,
  });

  if (reportSharedFailure(parsed, "question_escalate", result)) {
    return "reported";
  }
  if (result.status === "invalid-input") {
    return reportIssues(parsed, "question_escalate", "invalid_question_input", result.issues);
  }
  if (reportQuestionOutcome(parsed, "question_escalate", result)) {
    return "reported";
  }

  if (result.status === "delivery-started") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "delivery_started",
        blockers: [
          { reason: "delivery_started", questionId: result.questionId, state: result.state },
        ],
        operation: "question_escalate",
      },
      lines: [
        "An answer to this question is already on its way, so it is too late to escalate.",
        "Let the Operative acknowledge it, then raise the concern as a new question.",
      ],
    });
    return "reported";
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

async function runAnswer(parsed: ParsedArguments): Promise<Handled> {
  const { requestId, ownerToken, questionId, inputPath } = parsed.crew;
  const revision = readRevision(parsed);
  if (
    requestId === undefined ||
    ownerToken === undefined ||
    questionId === undefined ||
    inputPath === undefined ||
    revision === null
  ) {
    return "invalid-arguments";
  }

  const input = await readStructuredInput(inputPath);
  if (!input.ok) {
    return reportUnreadable(parsed, "question_answer", "invalid_answer_input", input.detail);
  }

  const { result } = await CrewState.answerQuestion({
    projectRoot: process.cwd(),
    requestId,
    ownerToken,
    questionId,
    revision,
    input: input.value,
  });

  if (reportSharedFailure(parsed, "question_answer", result)) {
    return "reported";
  }
  if (result.status === "invalid-input") {
    return reportIssues(parsed, "question_answer", "invalid_answer_input", result.issues);
  }
  if (reportQuestionOutcome(parsed, "question_answer", result)) {
    return "reported";
  }

  return reportRecordedAnswer(parsed, "question_answer", result);
}

async function runReapply(parsed: ParsedArguments): Promise<Handled> {
  const { requestId, ownerToken, questionId, answerId, approvalId } = parsed.crew;
  const revision = readRevision(parsed);
  if (
    requestId === undefined ||
    ownerToken === undefined ||
    questionId === undefined ||
    answerId === undefined ||
    approvalId === undefined ||
    revision === null
  ) {
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

  if (reportSharedFailure(parsed, "question_reapply", result)) {
    return "reported";
  }
  if (reportQuestionOutcome(parsed, "question_reapply", result)) {
    return "reported";
  }

  if (result.status === "unknown-answer") {
    report({
      json: parsed.json,
      result: {
        outcome: "invalid",
        reason: "unknown_answer",
        blockers: [{ reason: "unknown_answer", answerId: result.answerId }],
        operation: "question_reapply",
      },
      lines: [`This question holds no answer recorded as ${result.answerId}.`],
    });
    return "reported";
  }

  if (result.status === "answer-not-earlier") {
    report({
      json: parsed.json,
      result: {
        outcome: "invalid",
        reason: "answer_not_earlier",
        blockers: [
          {
            reason: "answer_not_earlier",
            answerId: result.answerId,
            questionRevision: result.questionRevision,
          },
        ],
        operation: "question_reapply",
      },
      lines: [
        `Answer ${result.answerId} was recorded for revision ${result.questionRevision}.`,
        "Only an answer from an earlier revision is reused.",
      ],
    });
    return "reported";
  }

  if (result.status === "unknown-approval") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "unknown_approval",
        blockers: [{ reason: "unknown_approval", approvalId: result.approvalId }],
        operation: "question_reapply",
      },
      lines: [`No approval is recorded as ${result.approvalId}.`],
    });
    return "reported";
  }

  if (result.status === "approval-revoked") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "approval_revoked",
        blockers: [{ reason: "approval_revoked", approvalId: result.approvalId }],
        operation: "question_reapply",
      },
      lines: [`Approval ${result.approvalId} is revoked, so it authorizes nothing.`],
    });
    return "reported";
  }

  if (result.status === "approval-mismatch") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "approval_mismatch",
        blockers: [
          {
            reason: "approval_mismatch",
            approvalId: result.approvalId,
            field: result.field,
          },
        ],
        operation: "question_reapply",
      },
      lines: [
        `Approval ${result.approvalId} was granted for a different ${result.field}.`,
        "An approval binds one exact action, its targets, its scope, and its request revision.",
      ],
    });
    return "reported";
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

async function runDeliver(parsed: ParsedArguments): Promise<Handled> {
  const { requestId, ownerToken, questionId } = parsed.crew;
  if (requestId === undefined || ownerToken === undefined || questionId === undefined) {
    return "invalid-arguments";
  }

  const { result } = await CrewState.deliverAnswer({
    projectRoot: process.cwd(),
    requestId,
    ownerToken,
    questionId,
  });

  if (reportSharedFailure(parsed, "question_deliver", result)) {
    return "reported";
  }
  if (reportQuestionOutcome(parsed, "question_deliver", result)) {
    return "reported";
  }

  if (result.status === "not-answered") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "answer_missing",
        blockers: [
          { reason: "answer_missing", questionId: result.questionId, state: result.state },
        ],
        operation: "question_deliver",
      },
      lines: [`Question ${result.questionId} holds no answer to deliver.`],
    });
    return "reported";
  }

  if (result.status === "reconciliation-required") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "reconciliation_required",
        blockers: [
          {
            reason: "reconciliation_required",
            questionId: result.questionId,
            operationState: result.operationState,
          },
        ],
        operation: "question_deliver",
      },
      lines: [
        `The delivery of this answer is ${result.operationState}, so it may already have arrived.`,
        "Run `operator attempt reconcile` before another delivery.",
      ],
    });
    return "reported";
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

async function runAcknowledge(parsed: ParsedArguments): Promise<Handled> {
  const { requestId, questionId } = parsed.crew;
  if (requestId === undefined || questionId === undefined) {
    return "invalid-arguments";
  }

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

  if (reportSharedFailure(parsed, "question_acknowledge", result)) {
    return "reported";
  }
  if (reportQuestionOutcome(parsed, "question_acknowledge", result)) {
    return "reported";
  }

  if (result.status === "not-delivered") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "question_not_delivered",
        blockers: [
          {
            reason: "question_not_delivered",
            questionId: result.questionId,
            state: result.state,
          },
        ],
        operation: "question_acknowledge",
      },
      lines: [`No answer to question ${result.questionId} has been sent yet.`],
    });
    return "reported";
  }

  if (result.status === "reference-mismatch") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "question_reference_mismatch",
        blockers: [
          {
            reason: "question_reference_mismatch",
            questionId: result.questionId,
            detail: result.detail,
          },
        ],
        operation: "question_acknowledge",
      },
      lines: [result.detail],
    });
    return "reported";
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

async function runShow(parsed: ParsedArguments): Promise<Handled> {
  const questionId = parsed.crew.questionId;
  if (questionId === undefined) {
    return "invalid-arguments";
  }

  const { result } = await CrewState.question({ projectRoot: process.cwd(), questionId });
  if (reportSharedFailure(parsed, "question_show", result)) {
    return "reported";
  }
  if (reportQuestionOutcome(parsed, "question_show", result)) {
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

export async function runQuestion(words: string[], parsed: ParsedArguments): Promise<Handled> {
  if (words.length !== 1) {
    return "invalid-arguments";
  }

  const [subcommand] = words;
  if (subcommand === "raise") {
    return runRaise(parsed);
  }
  if (subcommand === "revise") {
    return runRevise(parsed);
  }
  if (subcommand === "escalate") {
    return runEscalate(parsed);
  }
  if (subcommand === "answer") {
    return runAnswer(parsed);
  }
  if (subcommand === "reapply") {
    return runReapply(parsed);
  }
  if (subcommand === "deliver") {
    return runDeliver(parsed);
  }
  if (subcommand === "acknowledge") {
    return runAcknowledge(parsed);
  }
  if (subcommand === "show") {
    return runShow(parsed);
  }

  return "invalid-arguments";
}
