import { expect, test } from "bun:test";
import { CommitReview } from "./main.ts";

const head = "candidate";
const round = { head, findings: [] as { severity: string }[] };
test("a declined finding needs a nonblank reason at every policy consumer", () => {
  const rounds = [{ head, findings: [{ severity: "nice-to-have" }] }];
  for (const reason of [undefined, "", "  "])
    expect(
      CommitReview.decide(
        rounds,
        [{ round: 1, finding: 1, disposition: "declined", reason }],
        head,
      ),
    ).toBe("dispositions_incomplete");
});
test("finding identities and severities are independent of disposition counts", () => {
  const rounds = [{ head, findings: [{ severity: "nice-to-have" }, { severity: "blocker" }] }];
  expect(
    CommitReview.decide(
      rounds,
      [
        { round: 1, finding: 1, disposition: "applied" },
        { round: 1, finding: 2, disposition: "declined", reason: "Disproved." },
      ],
      head,
    ),
  ).toBe(null);
  expect(
    CommitReview.decide(
      rounds,
      [
        { round: 1, finding: 1, disposition: "applied" },
        { round: 1, finding: 3, disposition: "applied" },
      ],
      head,
    ),
  ).toBe("dispositions_incomplete");
});
test("delivery needs a complete exact-candidate review rather than approval-shaped PR facts", () => {
  expect(CommitReview.decide([], [], head)).toBe("review_missing");
  expect(CommitReview.decide([round], [], head)).toBe(null);
  expect(CommitReview.decide([round], [], "changed")).toBe("candidate_changed");
  expect(CommitReview.decide([round], [], null)).toBe("candidate_changed");
  expect(CommitReview.decide([{ head, findings: [{ severity: "blocker" }] }], [], head)).toBe(
    "dispositions_incomplete",
  );
  expect(
    CommitReview.decide(
      [{ head, findings: [{ severity: "blocker" }] }],
      [{ round: 1, finding: 1, disposition: "applied" }],
      head,
    ),
  ).toBe("blocker_requires_review");
});

test("second-round blocker fixes stop automatic delivery instead of permitting a third round", () => {
  const rounds = [
    { head: "old", findings: [{ severity: "blocker" }] },
    { head, findings: [{ severity: "blocker" }] },
  ];
  const dispositions = [
    { round: 1, finding: 1, disposition: "applied" },
    { round: 2, finding: 1, disposition: "applied" },
  ];
  expect(CommitReview.decide(rounds, dispositions, head)).toBe("review_limit");
  expect(
    CommitReview.decide(
      rounds,
      [
        { round: 1, finding: 1, disposition: "applied" },
        {
          round: 2,
          finding: 1,
          disposition: "declined",
          reason: "The claim is disproved by the contract.",
        },
      ],
      head,
    ),
  ).toBe(null);
  expect(
    CommitReview.decide(
      rounds,
      [...dispositions, { round: 1, finding: 1, disposition: "applied" }],
      head,
    ),
  ).toBe("dispositions_incomplete");
});
