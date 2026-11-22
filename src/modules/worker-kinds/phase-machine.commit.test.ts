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
  expect(decidePhase(facts)).toMatchObject({
    phase: "commit",
    next: { command: "operator commit review", why: "Start the fresh reviewer." },
  });
  expect(
    decidePhase({ ...facts, commit: { reviewing: true, rounds: 0, delivered: false } }).next
      .command,
  ).toBe("operator commit round --file <file>");
  expect(
    decidePhase({ ...facts, commit: { reviewing: true, rounds: 1, delivered: false } }).next
      .command,
  ).toBe("operator commit deliver --file <file>");
  expect(
    decidePhase({ ...facts, commit: { reviewing: true, rounds: 0, delivered: false } }),
  ).toMatchObject({
    phase: "commit-review",
    next: { why: "Review the exact ticket candidate before automatic delivery." },
  });
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

test("commit ownership refusal names the ticket rather than a PR", () => {
  expect(decidePhase({ ...facts, handedOff: true }, "commit-review")).toMatchObject({
    phase: "handoff",
    next: { why: "This launch handed the ticket to its fresh reviewer. Stop here." },
    refusal: {
      reason: "commit_handed_off",
      detail: "This launch no longer owns the ticket.",
      state: { handedOff: true },
    },
  });
});

test.each([
  ["commit-review", false, undefined, "pr_worktree_unclean", "git status --short"],
  ["commit-round", true, undefined, "commit_candidate_missing", "operator commit review"],
  [
    "commit-round",
    false,
    { reviewing: true, rounds: 0, delivered: false },
    "pr_worktree_unclean",
    "git status --short",
  ],
  [
    "commit-deliver",
    true,
    { reviewing: true, rounds: 0, delivered: false },
    "commit_review_missing",
    "operator commit round --file <file>",
  ],
] as const)(
  "the %s exit preserves its exact prerequisite refusal",
  (event, worktreeClean, commit, reason, command) => {
    const result = decidePhase({ ...facts, commit, worktreeClean }, event);
    expect(result.refusal).toMatchObject({ reason, detail: expect.stringMatching(/\S/) as string });
    expect(result.next.command).toBe(command);
    expect(result.next.why).toMatch(/\S/);
  },
);

test.each(["commit_candidate", "commit_reviewed", "commit_delivered"] as const)(
  "a declared %s guard reads commit evidence rather than unrelated PR facts",
  (guard) => {
    const guarded: PhaseFacts = {
      ...facts,
      kind: {
        name: "guarded-report",
        completion: "report",
        workPhases: [{ name: "inspect", guard }],
      },
    };
    expect(decidePhase(guarded, "submit").refusal).toMatchObject({
      detail: `The phase exit requires ${guard}.`,
      state: { [guard]: false },
    });
    if (guard === "commit_delivered")
      expect(decidePhase(guarded, "submit")).toMatchObject({
        next: {
          command: "operator commit deliver --file <file>",
          why: "Verify delivery to both local and remote main.",
        },
        refusal: { reason: "commit_not_delivered" },
      });
    expect(
      decidePhase(
        { ...guarded, commit: { reviewing: false, rounds: 0, delivered: false } },
        "submit",
      ).refusal,
    ).toBeDefined();
    expect(
      decidePhase({ ...guarded, commit: { reviewing: true, rounds: 1, delivered: true } }, "submit")
        .refusal,
    ).toBeUndefined();
  },
);
