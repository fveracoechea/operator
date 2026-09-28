import { expect, test } from "bun:test";
import { answerDocument } from "./answer.ts";

test("answer delivery uses the attempt's selected JSR invocation", () => {
  const text = answerDocument(
    {
      questionId: "question-1",
      questionRevision: 1,
      attemptId: "attempt-1",
      authority: "human-answer",
      exactText: "Use the new column.",
      interpretation: { summary: "Use it.", directives: ["Write it."], appliesTo: ["module"] },
      source: null,
    },
    "bun run operator",
  );

  expect(text).toContain("bun run operator question acknowledge --request");
});
