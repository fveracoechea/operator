import { expect, test } from "bun:test";
import { decidePhase } from "./phase-machine.ts";
import type { PhaseFacts, PhaseEvent } from "./phase-machine.ts";

function prFacts(): PhaseFacts {
  return {
    kind: { name: "custom", completion: "pr", workPhases: [] },
    report: null,
    pr: { associated: false, rounds: 0, ready: false, merged: false, parked: false },
    internalReview: true,
    worktreeClean: true,
  };
}

test("tail decisions include their complete next-action contract", () => {
  const facts = prFacts();
  expect(decidePhase(facts)).toEqual({
    kind: "custom",
    phase: "pr",
    next: { command: "operator pr associate", why: "Associate the pushed PR." },
    refusal: undefined,
  });
  const associated = { ...facts, pr: { ...facts.pr, associated: true } };
  const feedback = {
    kind: "custom",
    phase: "feedback",
    next: { command: "operator pr wait", why: "Wait for PR feedback or merge eligibility." },
    refusal: undefined,
  };
  expect(decidePhase({ ...associated, internalReview: false })).toEqual(feedback);
  expect(decidePhase({ ...associated, pr: { ...associated.pr, ready: true } })).toEqual(feedback);
  expect(decidePhase({ ...associated, pr: { ...associated.pr, rounds: 2 } }, "ready")).toEqual({
    kind: "custom",
    phase: "ready",
    next: {
      command: "operator pr ready --file <file>",
      why: "Resolve the recorded findings and mark the PR ready.",
    },
    refusal: undefined,
  });
  expect(decidePhase({ ...associated, pr: { ...associated.pr, parked: true } })).toEqual({
    kind: "custom",
    phase: "park",
    next: { why: "The PR is parked until a recorded event wakes it." },
    refusal: undefined,
  });
  expect(decidePhase({ ...associated, pr: { ...associated.pr, merged: true } })).toEqual({
    kind: "custom",
    phase: "complete",
    next: { why: "The assignment is complete. Nothing remains for this worker." },
    refusal: undefined,
  });
  const report = { ...facts, kind: { ...facts.kind, completion: "report" as const } };
  const submission = {
    kind: "custom",
    phase: "report",
    next: { command: "operator report submit --file <file>", why: "Submit the completed report." },
    refusal: undefined,
  };
  expect(decidePhase(report)).toEqual(submission);
  expect(
    decidePhase({ ...report, report: { returned: true, accepted: false, resumed: true } }),
  ).toEqual(submission);
  expect(
    decidePhase({ ...report, report: { returned: true, accepted: false, resumed: false } }),
  ).toEqual({
    kind: "custom",
    phase: "report",
    next: {
      command: "operator report resume",
      why: "Read the returned report's follow-up before submitting again.",
    },
    refusal: undefined,
  });
  expect(decidePhase({ ...report, report: { returned: false, accepted: false } })).toEqual({
    kind: "custom",
    phase: "acceptance",
    next: { decider: "super-agent", question: "Accept or return the submitted report?" },
    refusal: undefined,
  });
});

test.each(["round", "wait", "ready", "merge"] as const)(
  "%s refuses before PR association",
  (event) => {
    expect(decidePhase(prFacts(), event)).toEqual({
      kind: "custom",
      phase: "pr",
      next: { command: "operator pr associate", why: "Associate the pushed PR." },
      refusal: {
        reason: "pr_not_associated",
        detail: "The phase exit requires pr_associated.",
        state: { pr_associated: false },
      },
    });
  },
);

test.each(["associate", "ready", "merge"] as const)("%s requires a clean worktree", (event) => {
  const facts = prFacts();
  expect(
    decidePhase(
      {
        ...facts,
        worktreeClean: false,
        pr: { ...facts.pr, associated: true, rounds: 1, ready: true },
      },
      event,
    ),
  ).toEqual({
    kind: "custom",
    phase: "feedback",
    next: {
      command: "git status --short",
      why: "Inspect the local changes before committing or removing them.",
    },
    refusal: {
      reason: "pr_worktree_unclean",
      detail: "The phase exit requires worktree_clean.",
      state: { worktree_clean: false },
    },
  });
});

test("merge requires the ready transition and resume requires a recorded report", () => {
  const facts = prFacts();
  expect(
    decidePhase({ ...facts, pr: { ...facts.pr, associated: true, rounds: 1 } }, "merge"),
  ).toMatchObject({
    next: { command: "operator pr wait" },
    refusal: { reason: "pr_not_ready", state: { pr_ready: false } },
  });
  const reportFacts = { ...facts, kind: { ...facts.kind, completion: "report" as const } };
  expect(decidePhase(reportFacts, "resume")).toEqual({
    kind: "custom",
    phase: "report",
    next: { command: "operator report submit --file <file>", why: "Submit the completed report." },
    refusal: {
      reason: "report_not_submitted",
      detail: "The phase exit requires report_submitted.",
      state: { report_submitted: false },
    },
  });
  expect(
    decidePhase({ ...reportFacts, report: { accepted: false, returned: true } }, "resume").refusal,
  ).toBeUndefined();
  expect(
    decidePhase(
      { ...facts, internalReview: false, pr: { ...facts.pr, associated: true } },
      "merge",
    ),
  ).toMatchObject({
    next: { command: "operator pr wait", why: "Wait for current-head readiness evidence." },
    refusal: { reason: "pr_not_ready" },
  });
});

test("only round events consume the two-round bound", () => {
  const facts = prFacts();
  facts.pr.associated = true;
  for (const rounds of [0, 1])
    expect(decidePhase({ ...facts, pr: { ...facts.pr, rounds } }, "round").refusal).toBeUndefined();
  expect(decidePhase({ ...facts, pr: { ...facts.pr, rounds: 2 } }, "round").refusal).toEqual({
    reason: "internal_review_round_limit",
    detail: "The PR review loop is limited to two rounds.",
    state: { rounds: 2 },
  });
  for (const event of ["associate", "ready", "wait", "merge"] satisfies PhaseEvent[])
    expect(
      decidePhase({ ...facts, pr: { ...facts.pr, rounds: 2, ready: true } }, event).refusal,
    ).toBeUndefined();
});

test("work guards apply to either closing command, never to unrelated commands", () => {
  const facts = prFacts();
  facts.kind.workPhases = [
    { name: "free", goal: "Free work." },
    { name: "verify", guard: "pr_merged" },
  ];
  facts.pr.associated = true;
  expect(decidePhase(facts, "associate")).toMatchObject({
    next: { command: "operator pr wait", why: "Wait for a verified merge." },
    refusal: { reason: "pr_not_merged" },
  });
  expect(decidePhase(facts, "wait").refusal).toBeUndefined();
  expect(
    decidePhase({ ...facts, kind: { ...facts.kind, workPhases: [{ name: "free" }] } }, "associate")
      .refusal,
  ).toBeUndefined();
});

test("an outgoing launch never gets its fresh reviewer's next command", () => {
  const facts = prFacts();
  facts.pr.associated = true;
  expect(decidePhase({ ...facts, handedOff: true })).toEqual({
    kind: "custom",
    phase: "handoff",
    next: { why: "This launch handed the PR to its reviewer. Stop here." },
    refusal: undefined,
  });
  expect(decidePhase({ ...facts, handedOff: false })).toMatchObject({
    phase: "review",
    next: { command: "operator pr round --file <file>" },
  });
  expect(decidePhase({ ...facts, handedOff: true }, "ready")).toMatchObject({
    phase: "handoff",
    next: { why: "This launch handed the PR to its reviewer. Stop here." },
    refusal: {
      reason: "pr_handed_off",
      detail: "This launch no longer owns the PR.",
      state: { handedOff: true },
    },
  });
});

test.each([0, 1, 2])(
  "an ended review stays in feedback after readiness becomes unknown, with %i rounds",
  (rounds) => {
    const facts = {
      ...prFacts(),
      reviewEnded: true,
      pr: { associated: true, rounds, ready: false, merged: false, parked: false },
    };
    expect(decidePhase(facts)).toEqual({
      kind: "custom",
      phase: "feedback",
      next: { command: "operator pr wait", why: "Wait for PR feedback or merge eligibility." },
      refusal: undefined,
    });
    expect(decidePhase(facts, "merge")).toMatchObject({
      phase: "feedback",
      next: { command: "operator pr wait" },
      refusal: { reason: "pr_not_ready", state: { pr_ready: false } },
    });
  },
);

test("a phase exit command refuses until its guard holds, and names the next command", () => {
  const facts = {
    kind: { name: "review", completion: "pr" as const, workPhases: [] },
    report: null,
    pr: { associated: true, rounds: 0, ready: false, merged: false, parked: false },
    internalReview: true,
    worktreeClean: true,
  };
  expect(decidePhase(facts, "ready")).toEqual({
    kind: "review",
    phase: "review",
    next: { command: "operator pr round --file <file>", why: "Record the review findings." },
    refusal: {
      reason: "internal_review_round_missing",
      detail: "The phase exit requires round_recorded.",
      state: { round_recorded: false },
    },
  });
  expect(decidePhase({ ...facts, pr: { ...facts.pr, rounds: 1 } }, "ready")).toMatchObject({
    kind: "review",
    phase: "ready",
    next: { command: "operator pr ready --file <file>" },
  });
  expect(
    decidePhase({ ...facts, pr: { ...facts.pr, rounds: 1 } }, "ready").refusal,
  ).toBeUndefined();
});

test("report returns reopen only submission and acceptance completes the tail", () => {
  const facts = {
    kind: {
      name: "custom-research",
      completion: "report" as const,
      workPhases: [{ name: "investigate" }],
    },
    report: null,
    pr: { associated: false, rounds: 0, ready: false, merged: false, parked: false },
    internalReview: false,
    worktreeClean: true,
  };
  expect(decidePhase(facts)).toMatchObject({
    phase: "investigate",
    next: { command: "operator report submit --file <file>" },
  });
  expect(decidePhase({ ...facts, report: { returned: false, accepted: false } })).toMatchObject({
    phase: "acceptance",
    next: { decider: "super-agent" },
  });
  expect(decidePhase({ ...facts, report: { returned: true, accepted: false } })).toMatchObject({
    phase: "report",
  });
  expect(decidePhase({ ...facts, report: { returned: false, accepted: true } })).toMatchObject({
    phase: "complete",
  });
});

test("the PR tail bounds review to two rounds before ready, feedback, park and merge", () => {
  const facts = {
    kind: { name: "custom-pr", completion: "pr" as const, workPhases: [{ name: "build" }] },
    report: null,
    pr: { associated: false, rounds: 0, ready: false, merged: false, parked: false },
    internalReview: true,
    worktreeClean: true,
  };
  expect(decidePhase(facts)).toMatchObject({ phase: "build" });
  expect(decidePhase({ ...facts, pr: { ...facts.pr, associated: true } })).toMatchObject({
    phase: "review",
  });
  const two = { ...facts, pr: { ...facts.pr, associated: true, rounds: 2 } };
  expect(decidePhase(two, "round")).toMatchObject({
    phase: "ready",
    refusal: { reason: "internal_review_round_limit", state: { rounds: 2 } },
    next: { command: "operator pr ready --file <file>" },
  });
  expect(decidePhase({ ...two, pr: { ...two.pr, ready: true } })).toMatchObject({
    phase: "feedback",
  });
  expect(decidePhase({ ...two, pr: { ...two.pr, ready: true, parked: true } })).toMatchObject({
    phase: "park",
  });
  expect(
    decidePhase({ ...two, pr: { ...two.pr, ready: true, parked: true, merged: true } }),
  ).toMatchObject({ phase: "complete" });
});

test("kind work phase guards use the same closed catalog as tail exits", () => {
  const facts = {
    kind: {
      name: "custom",
      completion: "report" as const,
      workPhases: [{ name: "verify", guard: "pr_merged" as const }],
    },
    report: null,
    pr: { associated: true, rounds: 1, ready: true, merged: false, parked: false },
    internalReview: true,
    worktreeClean: true,
  };
  expect(decidePhase(facts, "submit")).toMatchObject({
    refusal: { reason: "pr_not_merged", state: { pr_merged: false } },
    next: { command: "operator pr wait" },
  });
  expect(
    decidePhase({ ...facts, pr: { ...facts.pr, merged: true } }, "submit").refusal,
  ).toBeUndefined();
});
