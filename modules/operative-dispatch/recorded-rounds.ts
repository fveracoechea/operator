// These follow the records in crew-state. A launch cannot import that module, because crew-state
// is what calls this one, so the shapes are restated rather than widened.

/** One decision a producer recorded in its submission, with the authority behind it. */
export type SubmittedDecision = {
  statement: string;
  authority: "requirement" | "human-answer" | "operator-decision";
  reason: string;
};

// Each behavior change with its basis. A submission recorded before the list existed holds null.
export type SubmittedBehaviorChanges = Array<{
  statement: string;
  basis:
    | { kind: "approved-scope" }
    | { kind: "requirement"; position: number }
    | { kind: "question"; questionId: string };
}> | null;

/**
 * One earlier round on the same assignment.
 * A revised result is reviewed against what those rounds found, their dispositions, and the
 * corrections that were delegated, so a regression is visible as one.
 */
export type PriorRound = {
  reviewId: string;
  submissionId: string;
  submissionIdentity: string;
  findings: Array<{
    findingId: string;
    axis: string;
    key: string;
    severity: string;
    summary: string;
    disposition: string | null;
    reason: string | null;
    // The rework cycle that delegated this finding as a correction, or null when none did.
    delegatedIn: string | null;
  }>;
  cycles: Array<{
    cycleId: string;
    reason: string;
    cycleIndex: number;
    conflicts: Array<{ summary: string; between: string[] }>;
  }>;
};

/**
 * One question an earlier attempt of the assignment asked, with the answer recorded for it.
 * The exact words stay beside the interpretation, so the reading never replaces what was said.
 */
export type AnsweredQuestion = {
  questionId: string;
  attemptId: string;
  question: string;
  authority: string;
  exactText: string | null;
  interpretation: { summary: string; directives: string[]; appliesTo: string[] };
};

function basisText(basis: NonNullable<SubmittedBehaviorChanges>[number]["basis"]): string {
  switch (basis.kind) {
    case "approved-scope":
      return "the approved scope";
    case "requirement":
      return `acceptance requirement ${basis.position}`;
    case "question":
      return `question ${basis.questionId}`;
  }
}

export function concernLines(concerns: string[]): string[] {
  return concerns.length === 0 ? ["None recorded."] : concerns.map((one) => `- ${one}`);
}

export function decisionLines(decisions: SubmittedDecision[]): string[] {
  return decisions.length === 0
    ? ["None recorded."]
    : decisions.map((one) => `- ${one.statement} (${one.authority}): ${one.reason}`);
}

export function behaviorChangeLines(behaviorChanges: SubmittedBehaviorChanges): string[] {
  if (behaviorChanges === null) {
    return ["This submission was recorded before the behavior change list existed."];
  }
  return behaviorChanges.length === 0
    ? ["The producer states that this result has no behavior change."]
    : behaviorChanges.map((one) => `- ${one.statement} (basis: ${basisText(one.basis)})`);
}

/** Each earlier round, with every finding, its disposition, and the cycles it led to. */
export function roundLines(rounds: PriorRound[]): string[] {
  return rounds.flatMap((round) => [
    `- Review ${round.reviewId} of submission ${round.submissionId}`,
    ...round.findings.map(
      (one) =>
        `  - ${one.findingId} (${one.axis}, ${one.severity}) ${one.disposition ?? "undisposed"}: ${one.summary}` +
        (one.reason === null ? "" : ` [${one.reason}]`) +
        (one.delegatedIn === null ? "" : ` Delegated in rework cycle ${one.delegatedIn}.`),
    ),
    ...round.cycles.flatMap((cycle) => [
      `  - Rework cycle ${cycle.cycleId} (${cycle.reason} ${cycle.cycleIndex})`,
      ...cycle.conflicts.map(
        (one) =>
          `    - Conflict settled by the Operative: ${one.summary} (${one.between.join(" and ")})`,
      ),
    ]),
  ]);
}

export function answeredQuestionLines(questions: AnsweredQuestion[]): string[] {
  return questions.length === 0
    ? ["None recorded."]
    : questions.flatMap((one) => [
        `- Question ${one.questionId}: ${one.question}`,
        `  Asked by attempt: ${one.attemptId}`,
        `  Authority: ${one.authority}`,
        `  Exact words: ${one.exactText ?? "none recorded"}`,
        `  Interpretation: ${one.interpretation.summary}`,
        "  Directives:",
        ...one.interpretation.directives.map((directive) => `    - ${directive}`),
        `  Applies to: ${one.interpretation.appliesTo.join(", ")}`,
      ]);
}
