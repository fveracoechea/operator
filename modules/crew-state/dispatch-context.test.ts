import { expect, test } from "bun:test";
import { reworkBriefOf } from "./dispatch-context.ts";
import { storedReworkBrief } from "./rework-input.ts";

const INSTRUCTION = "State the gate the result passed, and keep the approved scope.";

test("a rework brief never carries the instruction that an earlier release stored", () => {
  const stored = JSON.stringify({
    reason: "findings",
    cycleIndex: 1,
    limit: 3,
    approvalId: null,
    instruction: INSTRUCTION,
    reviewId: "review-1",
    submissionId: "submission-1",
    submissionIdentity: "identity-1",
    resultKind: "code",
    corrections: [],
    conflicts: [],
    combines: [],
    checks: [],
    code: null,
    artifacts: [],
  });
  const cycle = {
    id: "cycle-1",
    assignmentId: "assignment-1",
    submissionId: "submission-1",
    reviewId: "review-1",
    reason: "findings",
    cycleIndex: 1,
    brief: stored,
    briefIdentity: "brief-identity",
    attemptId: null,
    approvalId: null,
    state: "delegated",
    openedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const brief = reworkBriefOf({
    cycle,
    brief: storedReworkBrief(stored),
    rounds: {
      concerns: [],
      decisions: [],
      behaviorChanges: null,
      answeredQuestions: [],
      earlier: [],
    },
  });

  // The instruction is Operator text, and the Operator writes nothing into a brief.
  expect(brief).toMatchObject({ cycleId: "cycle-1", reason: "findings", cycleIndex: 1 });
  expect(JSON.stringify(brief)).not.toContain(INSTRUCTION);
});
