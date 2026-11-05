import { expect, test } from "bun:test";
import { decideInternalReview, decideOwnership } from "./internal-review-machine.ts";

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

test("only the launch that the handoff ended loses its PR commands", () => {
  expect(decideOwnership({ implementer: false })).toBeNull();
  expect(decideOwnership({ implementer: true })).toEqual({
    result: "refused",
    reason: "pr_handed_off",
    detail:
      "This launch handed the PR to its internal reviewer, so it runs no more PR commands. Stop here. Nothing was changed.",
  });
});
