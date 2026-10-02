import { expect, test } from "bun:test";
import { type ReworkBrief, reworkResultSection } from "./rework-brief.ts";

const REWORK: ReworkBrief = {
  cycleId: "cycle",
  reason: "findings",
  cycleIndex: 1,
  limit: 3,
  approvalId: null,
  reviewId: "review",
  submissionId: "submission",
  submissionIdentity: "result",
  resultKind: "code",
  corrections: [],
  conflicts: [],
  combines: [],
  checks: [],
  code: null,
  artifacts: [],
  rounds: {
    concerns: [],
    decisions: [],
    behaviorChanges: [],
    answeredQuestions: [],
    earlier: [],
  },
};

/** Each reason and the one sentence the release owns for it, as the fixture pins them. */
async function pinnedSentences(): Promise<Array<[ReworkBrief["reason"], string]>> {
  const fixture = await Bun.file(
    new URL("./rework-reasons.fixture.md", import.meta.url).pathname,
  ).text();
  return fixture
    .trim()
    .split("\n")
    .map((line) => {
      const [reason = "", ...rest] = line.split(": ");
      if (
        reason !== "findings" &&
        reason !== "integration" &&
        reason !== "diagnostic" &&
        reason !== "invalidation"
      ) {
        throw new Error(`the fixture names no reason on the line ${line}`);
      }
      return [reason, rest.join(": ")];
    });
}

test("each cycle reason renders the fixed sentence that the fixture pins", async () => {
  const pinned = await pinnedSentences();
  expect(pinned.map(([reason]) => reason)).toEqual([
    "findings",
    "integration",
    "diagnostic",
    "invalidation",
  ]);

  for (const [reason, sentence] of pinned) {
    const lines = reworkResultSection({ ...REWORK, reason });
    expect(lines).toContain(sentence);
    // No other reason's sentence reaches this brief.
    for (const [other, text] of pinned) {
      if (other !== reason) {
        expect(lines).not.toContain(text);
      }
    }
  }
});

test("states each empty record of the earlier rounds as none recorded", () => {
  const text = reworkResultSection(REWORK).join("\n");

  expect(text).toContain("### Answered questions\n\nNone recorded.\n");
  expect(text).toContain("### Earlier rounds on this assignment\n\nNone recorded.\n");
  expect(text).toContain(
    "### Behavior changes of the corrected submission\n\nThe producer states that this result has no behavior change.\n",
  );
});
