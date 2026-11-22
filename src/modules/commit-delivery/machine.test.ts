import { expect, test } from "bun:test";
import { reviewGate } from "./machine.ts";

const head = "candidate";
const round = { head, findings: [] as { severity: string }[] };
test("finding identities and severities are independent of disposition counts", () => {
  const rounds = [{ head, findings: [{ severity: "nice-to-have" }, { severity: "blocker" }] }];
  expect(
    reviewGate(
      rounds,
      [
        { round: 1, finding: 1, disposition: "applied" },
        { round: 1, finding: 2, disposition: "declined", reason: "Disproved." },
      ],
      head,
    ),
  ).toBe(null);
  expect(
    reviewGate(
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
  expect(reviewGate([], [], head)).toBe("review_missing");
  expect(reviewGate([round], [], head)).toBe(null);
  expect(reviewGate([round], [], "changed")).toBe("candidate_changed");
  expect(reviewGate([{ head, findings: [{ severity: "blocker" }] }], [], head)).toBe(
    "dispositions_incomplete",
  );
  expect(
    reviewGate(
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
  expect(reviewGate(rounds, dispositions, head)).toBe("review_limit");
  expect(
    reviewGate(
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
    reviewGate(rounds, [...dispositions, { round: 1, finding: 1, disposition: "applied" }], head),
  ).toBe("dispositions_incomplete");
});
