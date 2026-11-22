import { expect, test } from "bun:test";
import { CommitReview } from "./main.ts";

const blocker = { severity: "blocker" };
const suggestion = { severity: "nice-to-have" };

test("review needs all unique finding identities and reasons for declines", () => {
  expect(CommitReview.decide([], [])).toBe("review_missing");
  expect(CommitReview.decide([{ findings: [] }], [])).toBeNull();
  expect(CommitReview.decide([{ head: "recorded", findings: [] }], [])).toBeNull();
  const rounds = [{ findings: [suggestion, blocker] }];
  const applied = { round: 1, finding: 1, disposition: "applied" };
  const dispositions = [
    applied,
    { round: 1, finding: 2, disposition: "declined", reason: "Disproved." },
  ];
  expect(CommitReview.decide(rounds, dispositions)).toBeNull();
  for (const rows of [
    [],
    dispositions.slice(1),
    [...dispositions, applied],
    [applied, applied],
    [applied, { round: 2, finding: 2, disposition: "applied" }],
    [applied, { round: 1, finding: 3, disposition: "applied" }],
    [applied, { round: 1, finding: 2, disposition: "declined" }],
    [applied, { round: 1, finding: 2, disposition: "declined", reason: "" }],
    [applied, { round: 1, finding: 2, disposition: "declined", reason: "  " }],
  ])
    expect(CommitReview.decide(rounds, rows)).toBe("dispositions_incomplete");
});

test("only applied blockers in the final round require later review or a person", () => {
  expect(
    CommitReview.decide(
      [{ findings: [blocker] }],
      [{ round: 1, finding: 1, disposition: "applied" }],
    ),
  ).toBe("blocker_requires_review");
  const rounds = [{ findings: [blocker] }, { findings: [suggestion, blocker] }];
  const prior = { round: 1, finding: 1, disposition: "applied" };
  const applied = { round: 2, finding: 1, disposition: "applied" };
  const final = { round: 2, finding: 2, disposition: "applied" };
  expect(CommitReview.decide(rounds, [prior, applied, final])).toBe("review_limit");
  expect(
    CommitReview.decide(rounds, [
      prior,
      applied,
      { ...final, disposition: "declined", reason: "Disproved." },
    ]),
  ).toBeNull();
  expect(CommitReview.decide([{ findings: [blocker] }, { findings: [] }], [prior])).toBeNull();
});
