import { ContentIdentity } from "../content-identity/main.ts";

export type AnswerDelivery = {
  questionId: string;
  questionRevision: number;
  attemptId: string;
  authority: string;
  exactText: string | null;
  interpretation: { summary: string; directives: string[]; appliesTo: string[] };
  source: { id: string; revision: string } | null;
};

// The three authorities read differently to an Operative, so each one is named in plain words.
const authorityLine = {
  requirement: "This is a recorded requirement of the approved source.",
  "human-answer": "These are the user's own words. Treat them as the authority.",
  "operator-decision": "This is an Operator decision inside delegated authority.",
} as const;

function describeAuthority(authority: string): string {
  return Object.hasOwn(authorityLine, authority)
    ? authorityLine[authority as keyof typeof authorityLine]
    : `Authority: ${authority}.`;
}

/**
 * The message one Operative receives as the answer to its question.
 * The exact words stay separate from the reading of them, so the Operative can see what was
 * said and what it means without the two being merged.
 */
export function answerDocument(answer: AnswerDelivery): string {
  return [
    `Answer to question ${answer.questionId} revision ${answer.questionRevision} on attempt ${answer.attemptId}.`,
    "",
    describeAuthority(answer.authority),
    ...(answer.source === null
      ? []
      : [`Source: ${answer.source.id} at revision ${answer.source.revision}.`]),
    "",
    ...(answer.exactText === null
      ? ["No exact text stands behind this answer."]
      : ["Exact words:", "", answer.exactText]),
    "",
    "Interpretation:",
    "",
    answer.interpretation.summary,
    "",
    ...answer.interpretation.directives.map((one) => `- ${one}`),
    "",
    `Applies to: ${answer.interpretation.appliesTo.join(", ")}.`,
    "",
    "Acknowledge this answer before you act on it:",
    "",
    `operator question acknowledge --request <a new identity you generate> --question ${answer.questionId} --json`,
    "",
    "Run it from this worktree. Nothing in this answer widens your recorded authority limits.",
  ].join("\n");
}

export function answerIdentity(answer: AnswerDelivery): string {
  return ContentIdentity.ofText(answerDocument(answer));
}
