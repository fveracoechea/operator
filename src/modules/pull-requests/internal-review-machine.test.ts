import { expect, test } from "bun:test";
import {
  decideInternalReview as internalReviewDecision,
  decideOwnership,
} from "./internal-review-machine.ts";
import { expectRefusalContext } from "../../lib/cli-result-fixture.ts";

function decideInternalReview(...args: Parameters<typeof internalReviewDecision>) {
  const result = internalReviewDecision(...args);
  if (args[0].event === "skip" && result.result === "refused") expectRefusalContext(result);
  return result;
}

const draft = {
  event: "associate" as const,
  internalReview: true,
  draft: true,
  changed: false,
  localHead: "h1" as string | null,
  prHead: "h1",
};

test("a clean, pushed draft starts an internal review", () => {
  expect(decideInternalReview(draft)).toEqual({ result: "associate", review: true });
});

test("with internal review on, each unready PR or worktree refuses with its own reason", () => {
  const cases: [Partial<typeof draft>, string, string][] = [
    [{ draft: false }, "pr_draft_required", "gh pr ready --undo"],
    [{ changed: true }, "pr_worktree_unclean", "untracked files"],
    [{ localHead: "h0" }, "pr_worktree_unsynced", "The worktree is at h0, but the PR head is h1."],
    [{ localHead: null }, "pr_worktree_unsynced", "The worktree is at no commit"],
  ];
  for (const [change, reason, text] of cases) {
    const decision = decideInternalReview({ ...draft, ...change });
    expect(decision).toMatchObject({ result: "refused", reason });
    expect("detail" in decision ? decision.detail : "").toContain(text);
    expect("detail" in decision ? decision.detail : "").toEndWith("Nothing was changed.");
  }
  // The draft check comes first, so a ready PR is never reported as an unclean worktree.
  expect(decideInternalReview({ ...draft, draft: false, changed: true })).toMatchObject({
    reason: "pr_draft_required",
  });
  expect(decideInternalReview({ ...draft, changed: true, localHead: "h0" })).toMatchObject({
    reason: "pr_worktree_unclean",
  });
});

test("with internal review off, any open PR is associated as before", () => {
  expect(
    decideInternalReview({
      ...draft,
      internalReview: false,
      draft: false,
      changed: true,
      localHead: "h0",
    }),
  ).toEqual({ result: "associate", review: false });
});

test("the handoff closes a live implementer's pane and starts the reviewer once", () => {
  function handoff(state: string, paneId: string | null, reviewerStarted: boolean) {
    return decideInternalReview({
      event: "handoff",
      implementer: { state, paneId },
      reviewerStarted,
    });
  }
  expect(handoff("running", "p1", false)).toEqual({
    result: "handoff",
    closePane: true,
    dispatch: true,
  });
  expect(handoff("starting", "p1", false)).toMatchObject({ closePane: true, dispatch: true });
  // A pane that already ended, or none, needs no close. A retry still starts the reviewer.
  for (const state of ["interrupted", "finished", "failed"])
    expect(handoff(state, "p1", false)).toMatchObject({ closePane: false, dispatch: true });
  expect(handoff("running", null, false)).toMatchObject({ closePane: false, dispatch: true });
  // A started reviewer finishes the handoff, so a repeat changes nothing.
  expect(handoff("running", "p1", true)).toEqual({
    result: "handoff",
    closePane: false,
    dispatch: false,
  });
});

const reviewing = {
  event: "round" as const,
  review: { state: "reviewing", rounds: [] as { head: string }[] },
  implementer: false,
  localHead: "h1" as string | null,
};

test("the first round, and a second round at a newer head, are recorded", () => {
  expect(decideInternalReview(reviewing)).toEqual({ result: "round", number: 1, head: "h1" });
  expect(
    decideInternalReview({
      ...reviewing,
      review: { state: "reviewing", rounds: [{ head: "h0" }] },
    }),
  ).toEqual({ result: "round", number: 2, head: "h1" });
});

test("each round refusal names its reason and changes nothing", () => {
  const cases: [Partial<typeof reviewing>, string, string][] = [
    [{ implementer: true }, "pr_handed_off", "handed the PR to its internal reviewer"],
    [{ review: { state: "ready", rounds: [] } }, "internal_review_ended", "has ended"],
    [{ review: { state: "skipped", rounds: [] } }, "internal_review_ended", "has ended"],
    [
      { review: { state: "reviewing", rounds: [{ head: "h0" }, { head: "h2" }] } },
      "internal_review_round_limit",
      "two rounds, its limit",
    ],
    [
      { review: { state: "reviewing", rounds: [{ head: "h1" }] } },
      "internal_review_round_head",
      "Round 1 already reviewed h1.",
    ],
    [{ localHead: null }, "internal_review_head_missing", "no commit"],
  ];
  for (const [change, reason, text] of cases) {
    const decision = decideInternalReview({ ...reviewing, ...change });
    expect(decision).toMatchObject({ result: "refused", reason });
    expect("detail" in decision ? decision.detail : "").toContain(text);
    expect("detail" in decision ? decision.detail : "").toEndWith("Nothing was changed.");
  }
});

test("round refusals keep their order: owner, end, limit, then head", () => {
  const ended = { state: "ready", rounds: [{ head: "h1" }, { head: "h2" }] };
  expect(decideInternalReview({ ...reviewing, implementer: true, review: ended })).toMatchObject({
    reason: "pr_handed_off",
  });
  expect(decideInternalReview({ ...reviewing, review: ended })).toMatchObject({
    reason: "internal_review_ended",
  });
  expect(
    decideInternalReview({
      ...reviewing,
      review: { state: "reviewing", rounds: [{ head: "h1" }, { head: "h2" }] },
    }),
  ).toMatchObject({ reason: "internal_review_round_limit" });
});

const blocker1 = { head: "h1", findings: [{ severity: "blocker" }, { severity: "nice-to-have" }] };
const ready = {
  event: "ready" as const,
  review: { state: "reviewing", rounds: [blocker1, { head: "h2", findings: [] }] },
  implementer: false,
  dispositions: [
    { round: 1, finding: 1, disposition: "applied" as const },
    { round: 1, finding: 2, disposition: "declined" as const },
  ],
  changed: false,
  localHead: "h3" as string | null,
  pr: { state: "OPEN", head: "h3", draft: true },
  posted: "none" as "none" | "current" | "stale",
};

test("a complete review posts its comment and marks the draft ready at the PR head", () => {
  expect(decideInternalReview(ready)).toEqual({
    result: "ready",
    head: "h3",
    comment: "post",
    markReady: true,
  });
  // A retry after a lost answer finds the comment and a PR that already left draft.
  expect(
    decideInternalReview({ ...ready, posted: "current", pr: { ...ready.pr, draft: false } }),
  ).toEqual({ result: "ready", head: "h3", comment: "keep", markReady: false });
  // A retry after a later push or round finds an older comment and replaces its text.
  expect(decideInternalReview({ ...ready, posted: "stale" })).toEqual({
    result: "ready",
    head: "h3",
    comment: "update",
    markReady: true,
  });
});

test("one round without an applied blocker ends the review", () => {
  function one(severity: string, disposition: "applied" | "declined") {
    return decideInternalReview({
      ...ready,
      review: { state: "reviewing", rounds: [{ head: "h1", findings: [{ severity }] }] },
      dispositions: [{ round: 1, finding: 1, disposition }],
    });
  }
  expect(one("nice-to-have", "applied")).toMatchObject({ result: "ready" });
  // A declined blocker moves no code, so its reason in the comment is the end.
  expect(one("blocker", "declined")).toMatchObject({ result: "ready" });
  expect(one("blocker", "applied")).toEqual({
    result: "refused",
    reason: "internal_review_second_round_required",
    detail:
      "Round 1 had a blocker that you applied, so its fixes need round 2. Push them, then record round 2 with a fresh subagent. Nothing was changed.",
  });
  // Only the disposition of the blocker itself decides, not that of another finding.
  function mixed(blocker: "applied" | "declined", nice: "applied" | "declined") {
    return decideInternalReview({
      ...ready,
      review: { state: "reviewing", rounds: [blocker1] },
      dispositions: [
        { round: 1, finding: 1, disposition: blocker },
        { round: 1, finding: 2, disposition: nice },
      ],
    });
  }
  expect(mixed("declined", "applied")).toMatchObject({ result: "ready" });
  expect(mixed("applied", "declined")).toMatchObject({
    reason: "internal_review_second_round_required",
  });
  expect(
    decideInternalReview({
      ...ready,
      review: { state: "reviewing", rounds: [{ head: "h1", findings: [] }] },
      dispositions: [],
    }),
  ).toMatchObject({ result: "ready" });
});

test("each unfinished review, summary, or worktree refuses the ready step with its own reason", () => {
  const cases: [Partial<typeof ready>, string, string][] = [
    [{ implementer: true }, "pr_handed_off", "handed the PR"],
    [
      { review: { state: "skipped", rounds: ready.review.rounds } },
      "internal_review_ended",
      "already ended skipped",
    ],
    [{ pr: { ...ready.pr, state: "MERGED" } }, "pr_not_open", "not open"],
    [
      { review: { state: "reviewing", rounds: [] }, dispositions: [] },
      "internal_review_round_missing",
      "operator pr round",
    ],
    [
      {
        dispositions: [...ready.dispositions, { round: 2, finding: 1, disposition: "applied" }],
      },
      "internal_review_summary_invalid",
      "No recorded finding is 2.1.",
    ],
    [
      {
        dispositions: [...ready.dispositions, { round: 3, finding: 1, disposition: "applied" }],
      },
      "internal_review_summary_invalid",
      "No recorded finding is 3.1.",
    ],
    [
      {
        dispositions: [...ready.dispositions, { round: 1, finding: 2, disposition: "applied" }],
      },
      "internal_review_summary_invalid",
      "Findings 1.2 have more than one disposition.",
    ],
    [
      { dispositions: [] },
      "internal_review_summary_incomplete",
      "Findings 1.1, 1.2 have no disposition.",
    ],
    [
      { dispositions: ready.dispositions.slice(1) },
      "internal_review_summary_incomplete",
      "Findings 1.1 have no disposition.",
    ],
    [{ changed: true }, "pr_worktree_unclean", "untracked files"],
    [{ localHead: "h2" }, "pr_worktree_unsynced", "The worktree is at h2, but the PR head is h3."],
    [{ localHead: null }, "pr_worktree_unsynced", "The worktree is at no commit"],
  ];
  for (const [change, reason, text] of cases) {
    const decision = decideInternalReview({ ...ready, ...change });
    expect(decision, reason).toMatchObject({ result: "refused", reason });
    expect("detail" in decision ? decision.detail : "").toContain(text);
    expect("detail" in decision ? decision.detail : "").toEndWith("Nothing was changed.");
  }
  // Every unknown or repeated finding is named.
  expect(
    decideInternalReview({
      ...ready,
      dispositions: [
        ...ready.dispositions,
        { round: 2, finding: 1, disposition: "applied" },
        { round: 3, finding: 2, disposition: "applied" },
      ],
    }),
  ).toMatchObject({
    detail:
      "No recorded finding is 2.1, 3.2. Name each finding as round and finding number. Nothing was changed.",
  });
  expect(
    decideInternalReview({
      ...ready,
      dispositions: [...ready.dispositions, ...ready.dispositions],
    }),
  ).toMatchObject({
    detail: "Findings 1.1, 1.2 have more than one disposition. Nothing was changed.",
  });
  // A handed-off launch is refused before it learns anything about the review.
  expect(
    decideInternalReview({ ...ready, implementer: true, review: { state: "ready", rounds: [] } }),
  ).toMatchObject({ reason: "pr_handed_off" });
  // A summary is checked before the worktree, so the reviewer fixes the file first.
  expect(decideInternalReview({ ...ready, dispositions: [], changed: true })).toMatchObject({
    reason: "internal_review_summary_incomplete",
  });
  expect(decideInternalReview({ ...ready, changed: true, localHead: "h2" })).toMatchObject({
    reason: "pr_worktree_unclean",
  });
});

const skip = {
  event: "skip" as const,
  personInstructed: true,
  review: "reviewing" as string | null,
  pr: { state: "OPEN", head: "h4", draft: true } as {
    state: string;
    head: string;
    draft: boolean;
  } | null,
};

test("a person-instructed skip ends a running review at the PR head and marks a draft ready", () => {
  expect(decideInternalReview(skip)).toEqual({ result: "skip", head: "h4", markReady: true });
  expect(
    decideInternalReview({ ...skip, pr: { state: "OPEN", head: "h4", draft: false } }),
  ).toEqual({ result: "skip", head: "h4", markReady: false });
});

test("a skip refuses without the person's instruction, a running review, or an open PR", () => {
  const cases: [Partial<typeof skip>, string, string][] = [
    [{ personInstructed: false }, "person_instruction_required", "--person-instructed"],
    [{ review: null }, "internal_review_not_recorded", "no internal review"],
    [{ review: "ready" }, "internal_review_ended", "already ended ready"],
    [{ pr: { state: "CLOSED", head: "h4", draft: false } }, "pr_not_open", "not open"],
    [{ pr: null }, "pr_not_open", "not open"],
  ];
  for (const [change, reason, text] of cases) {
    const decision = decideInternalReview({ ...skip, ...change });
    expect(decision, reason).toMatchObject({ result: "refused", reason });
    expect("detail" in decision ? decision.detail : "").toContain(text);
    expect("detail" in decision ? decision.detail : "").toEndWith("Nothing was changed.");
  }
  expect(decideInternalReview({ ...skip, personInstructed: false, review: null })).toMatchObject({
    reason: "person_instruction_required",
    next: { decider: "person", question: "May this command run on your explicit instruction?" },
    state: { personInstructed: false },
  });
  expect(decideInternalReview({ ...skip, review: null })).toMatchObject({
    next: { why: "No internal review exists to skip." },
    state: { review: null },
  });
  expect(decideInternalReview({ ...skip, review: "ready" })).toMatchObject({
    next: { why: "The internal review has already ended. No skip remains." },
    state: { review: "ready" },
  });
  expect(
    decideInternalReview({ ...skip, pr: { state: "CLOSED", head: "h1", draft: true } }),
  ).toMatchObject({
    reason: "pr_not_open",
    next: {
      decider: "person",
      question: "How should the closed PR be handled before this review can continue?",
    },
    state: { prState: "CLOSED" },
  });
});

test("only the launch that the handoff ended loses its PR commands", () => {
  expect(decideOwnership({ implementer: false })).toBeNull();
  expect(decideOwnership({ implementer: true })).toEqual({
    result: "refused",
    reason: "pr_handed_off",
    detail:
      "This launch handed the PR to its internal reviewer, so it runs no more PR commands. Stop here. Nothing was changed.",
  });
});
