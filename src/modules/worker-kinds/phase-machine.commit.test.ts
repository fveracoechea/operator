import { expect, test } from "bun:test";
import { decidePhase, type PhaseFacts } from "./phase-machine.ts";

const facts: PhaseFacts = {
  kind: { name: "commit-implementation", completion: "commit", workPhases: [] },
  report: null,
  pr: { associated: false, rounds: 0, ready: false, merged: false, parked: false },
  internalReview: true,
  worktreeClean: true,
};

test("commit completion has its own closing commands rather than a fabricated PR tail", () => {
  expect(decidePhase(facts).next.command).toBe("operator commit review");
  expect(
    decidePhase({ ...facts, commit: { reviewing: true, rounds: 0, delivered: false } }).next
      .command,
  ).toBe("operator commit round --file <file>");
  expect(
    decidePhase({ ...facts, commit: { reviewing: true, rounds: 1, delivered: false } }).next
      .command,
  ).toBe("operator commit deliver --file <file>");
  expect(
    decidePhase({ ...facts, commit: { reviewing: true, rounds: 1, delivered: true } }).phase,
  ).toBe("complete");
  expect(decidePhase({ ...facts, handedOff: true }).phase).toBe("handoff");
});

test("commit prerequisites are not inferred from PR approval-shaped facts", () => {
  expect(
    decidePhase({
      ...facts,
      pr: { associated: true, rounds: 2, ready: true, merged: true, parked: false },
    }).phase,
  ).toBe("commit");
  expect(decidePhase(facts, "commit-round").refusal?.reason).toBe("commit_candidate_missing");
  expect(
    decidePhase(
      { ...facts, commit: { reviewing: true, rounds: 0, delivered: false } },
      "commit-deliver",
    ).refusal?.reason,
  ).toBe("commit_review_missing");
});
