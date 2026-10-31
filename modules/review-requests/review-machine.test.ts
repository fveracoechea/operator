import { expect, test } from "bun:test";
import {
  decideReview,
  headMoveLimit,
  reviewAction,
  type ReviewCommand,
  type ReviewFacts,
} from "./review-machine.ts";

type Request = {
  state: string;
  launchState: string | null;
  head?: string | null;
  headMoves?: number;
  sync?: string | null;
  cleanupState?: string | null;
};
function facts(
  command: ReviewCommand,
  request: Request | null,
  change: Partial<Omit<ReviewFacts, "command" | "request">> = {},
): ReviewFacts {
  return { command, request, registered: true, ownerActive: false, ...change };
}
const queued = { state: "queued", launchState: null };

test("an unregistered repository is refused before any other rule", () => {
  for (const command of ["add", "start", "post"] as const)
    expect(decideReview(facts(command, queued, { registered: false }))).toMatchObject({
      tag: "Err",
      error: { reason: "review_repository_unregistered" },
    });
});

test("add queues once, and a repeated add changes nothing", () => {
  expect(decideReview(facts("add", null))).toMatchObject({
    tag: "Ok",
    value: { insert: true, state: "queued" },
  });
  expect(decideReview(facts("add", queued))).toMatchObject({
    tag: "Ok",
    value: { unchanged: true },
  });
});

test("a start holds the request, refuses a live start, and retries a failed or abandoned one", () => {
  expect(decideReview(facts("start", null))).toMatchObject({
    error: { reason: "review_request_missing" },
  });
  expect(decideReview(facts("start", queued))).toMatchObject({
    value: { launchState: "starting", lease: "hold" },
  });
  const starting = { state: "queued", launchState: "starting" };
  expect(decideReview(facts("start", starting, { ownerActive: true }))).toMatchObject({
    error: { reason: "review_start_in_progress" },
  });
  expect(decideReview(facts("start", starting)).tag).toBe("Ok");
  expect(decideReview(facts("start", { state: "queued", launchState: "failed" })).tag).toBe("Ok");
  expect(
    decideReview(facts("start", { state: "reviewing", launchState: "running" })),
  ).toMatchObject({
    error: { reason: "review_reviewer_started" },
  });
  expect(decideReview(facts("started", starting))).toMatchObject({
    value: { state: "reviewing", launchState: "running", lease: "release" },
  });
  expect(decideReview(facts("started", queued))).toMatchObject({
    error: { reason: "review_start_interrupted" },
  });
  expect(decideReview(facts("start_failed", starting))).toMatchObject({
    value: { launchState: "failed", lease: "release" },
  });
});

test("a post moves to posting once, and repeated or concurrent posts are refused", () => {
  const reviewing = { state: "reviewing", launchState: "running" };
  for (const request of [queued, reviewing])
    expect(decideReview(facts("post", request))).toMatchObject({
      value: { state: "posting", lease: "hold" },
    });
  const posting = { state: "posting", launchState: "running" };
  expect(decideReview(facts("post", posting, { ownerActive: true }))).toMatchObject({
    error: { reason: "review_post_in_progress" },
  });
  expect(decideReview(facts("post", posting))).toMatchObject({
    value: { lease: "hold", retry: true },
  });
  expect(
    decideReview(
      facts("post", { state: "queued", launchState: "starting" }, { ownerActive: true }),
    ),
  ).toMatchObject({
    error: { reason: "review_start_in_progress" },
  });
  for (const state of ["watching", "approved"])
    expect(decideReview(facts("post", { state, launchState: null }))).toMatchObject({
      error: { reason: "review_already_posted" },
    });
});

test("a post result approves, watches, returns the request, or keeps it posting", () => {
  const posting = { state: "posting", launchState: "running" };
  // The post keeps the lease, so it releases the reviewer of the approval itself.
  expect(decideReview(facts("posted", posting, { event: "APPROVE" }))).toMatchObject({
    value: { state: "approved", cleanup: true, lease: "hold" },
  });
  // An approved request is not ended, because a renewed request reopens it.
  expect(decideReview(facts("posted", posting, { event: "APPROVE" }))).not.toMatchObject({
    value: { ended: true },
  });
  for (const event of ["COMMENT", "REQUEST_CHANGES"]) {
    const watched = decideReview(facts("posted", posting, { event }));
    expect(watched).toMatchObject({ value: { state: "watching", lease: "release" } });
    expect(watched.tag === "Ok" && watched.value.cleanup).toBeUndefined();
  }
  expect(decideReview(facts("posted", reviewingOf()))).toMatchObject({
    error: { reason: "review_post_interrupted" },
  });
  expect(decideReview(facts("post_failed", posting))).toMatchObject({
    value: { state: "reviewing" },
  });
  expect(decideReview(facts("post_failed", { state: "posting", launchState: null }))).toMatchObject(
    {
      value: { state: "queued" },
    },
  );
  expect<unknown>(decideReview(facts("post_uncertain", posting))).toEqual({
    tag: "Ok",
    value: { lease: "release" },
  });
});

function reviewingOf() {
  return { state: "reviewing", launchState: "running" };
}

test("next actions derive from recorded state and the owner's lease alone", () => {
  expect(reviewAction(queued, false)).toEqual({
    kind: "action",
    action: "start_reviewer",
    reason: "review_queued",
  });
  expect(reviewAction({ state: "queued", launchState: "failed" }, false)).toMatchObject({
    reason: "launch_failed",
  });
  expect(reviewAction({ state: "queued", launchState: "starting" }, true)).toEqual({
    kind: "wait",
    reason: "reviewer_starting",
  });
  expect(reviewAction({ state: "queued", launchState: "starting" }, false)).toMatchObject({
    reason: "launch_abandoned",
  });
  expect(reviewAction(reviewingOf(), false)).toEqual({ kind: "wait", reason: "review_draft" });
  expect(reviewAction({ state: "posting", launchState: null }, true)).toEqual({
    kind: "wait",
    reason: "review_posting",
  });
  expect(reviewAction({ state: "posting", launchState: null }, false)).toEqual({
    kind: "action",
    action: "post_review",
    reason: "review_post_uncertain",
  });
  expect(reviewAction({ state: "watching", launchState: null }, false)).toEqual({
    kind: "wait",
    reason: "review_watching",
  });
});

test("a renewed add or an observed trigger starts a round with the reviewer that the request has", () => {
  const running = { state: "watching", launchState: "running" };
  expect(decideReview(facts("add", running))).toMatchObject({
    value: { state: "reviewing", round: "re-request", sync: true, lease: "hold" },
  });
  expect(decideReview(facts("add", { ...running, state: "approved" }))).toMatchObject({
    value: { state: "reviewing", round: "re-request" },
  });
  for (const state of ["queued", "reviewing", "posting"])
    expect(decideReview(facts("add", { state, launchState: "running" }))).toMatchObject({
      value: { unchanged: true },
    });
  for (const trigger of ["commits", "reply", "resolved", "re-request"] as const)
    expect(decideReview(facts("round", running, { trigger }))).toMatchObject({
      value: { state: "reviewing", round: trigger, sync: true },
    });
  // A stopped reviewer gets no prompt. The replacement gets the round.
  const stopped = decideReview(
    facts("round", { state: "watching", launchState: "interrupted" }, { trigger: "reply" }),
  );
  expect(stopped).toMatchObject({ value: { state: "reviewing", round: "reply" } });
  expect(stopped.tag === "Ok" && stopped.value.sync).toBeUndefined();
  // A request that never had a reviewer queues the round.
  expect(
    decideReview(facts("round", { state: "watching", launchState: null }, { trigger: "commits" })),
  ).toMatchObject({ value: { state: "queued", round: "commits" } });
  // A renewal waits while the reviewer of an approved request is cleaned up.
  const releasing = { state: "approved", launchState: "running", cleanupState: "pending" };
  expect(decideReview(facts("add", releasing))).toMatchObject({
    error: {
      reason: "review_cleanup_in_progress",
      detail:
        "The reviewer cleanup of this approved request has not finished. Add the request again after operator review wait or operator review cleanup finishes it. Nothing changed.",
    },
  });
  expect(decideReview(facts("round", releasing, { trigger: "re-request" }))).toMatchObject({
    value: { unchanged: true },
  });
  for (const cleanupState of ["done", "kept", "failed"])
    expect(
      decideReview(facts("round", { ...releasing, cleanupState }, { trigger: "re-request" })),
    ).toMatchObject({ value: { state: "reviewing", round: "re-request" } });
  // A pending cleanup of an ended request is not a release.
  expect(decideReview(facts("add", { ...releasing, state: "watching" }))).toMatchObject({
    value: { state: "reviewing", round: "re-request" },
  });
  // Only a renewed request reopens an approved request, and a second wait finds nothing to do.
  expect(
    decideReview(facts("round", { ...running, state: "approved" }, { trigger: "commits" })),
  ).toMatchObject({ value: { unchanged: true } });
  expect(
    decideReview(facts("round", { ...running, state: "reviewing" }, { trigger: "commits" })),
  ).toMatchObject({ value: { unchanged: true } });
});

test("a head move counts once per observed head, stops at the limit, and waits for a running move", () => {
  const reviewing = { state: "reviewing", launchState: "running", head: "h1", headMoves: 0 };
  expect(decideReview(facts("head_moved", reviewing, { observedFrom: "h1" }))).toMatchObject({
    value: { headMoved: true, sync: true, lease: "hold" },
  });
  expect<unknown>(
    decideReview(
      facts("head_moved", { ...reviewing, launchState: "interrupted" }, { observedFrom: "h1" }),
    ),
  ).toEqual({ tag: "Ok", value: { headMoved: true } });
  for (const request of [
    { ...reviewing, head: "h2" },
    { ...reviewing, headMoves: headMoveLimit },
    { ...reviewing, sync: "{}" },
    { ...reviewing, state: "watching" },
    { ...reviewing, launchState: "starting" },
  ])
    expect(decideReview(facts("head_moved", request, { observedFrom: "h1" }))).toMatchObject({
      value: { unchanged: true },
    });
  expect(
    decideReview(
      facts("head_moved", { ...reviewing, headMoves: headMoveLimit - 1 }, { observedFrom: "h1" }),
    ),
  ).toMatchObject({
    value: { headMoved: true },
  });
  // A post waits for a move in progress, and a stopped move is resumed by one wait.
  expect(
    decideReview(facts("post", { ...reviewing, sync: "{}" }, { ownerActive: true })),
  ).toMatchObject({ error: { reason: "review_reviewer_moving" } });
  expect(decideReview(facts("sync", { ...reviewing, sync: "{}" }))).toMatchObject({
    value: { lease: "hold" },
  });
  expect(
    decideReview(facts("sync", { ...reviewing, sync: "{}" }, { ownerActive: true })),
  ).toMatchObject({ value: { unchanged: true } });
  expect(decideReview(facts("sync", reviewing))).toMatchObject({ value: { unchanged: true } });
});

test("a stopped reviewer gets a replacement that keeps the request's state", () => {
  for (const state of ["reviewing", "watching", "approved"])
    for (const launchState of ["interrupted", "failed"])
      expect(decideReview(facts("start", { state, launchState }))).toMatchObject({
        value: { launchState: "starting", lease: "hold", replace: true },
      });
  // A replacement start that died leaves "starting" with no live owner.
  for (const state of ["reviewing", "watching", "approved"]) {
    const abandoned = { state, launchState: "starting" };
    expect(decideReview(facts("start", abandoned))).toMatchObject({
      value: { launchState: "starting", lease: "hold", replace: true },
    });
    expect(reviewAction(abandoned, false)).toEqual({
      kind: "action",
      action: "replace_reviewer",
      reason: "launch_abandoned",
    });
    expect(reviewAction(abandoned, true)).toEqual({ kind: "wait", reason: "reviewer_starting" });
  }
  const replacing = { state: "watching", launchState: "starting" };
  const started = decideReview(facts("started", replacing));
  expect(started).toMatchObject({ value: { launchState: "running", lease: "release" } });
  expect(started.tag === "Ok" && started.value.state).toBeUndefined();
  expect(
    decideReview(facts("post_failed", { state: "posting", launchState: "interrupted" })),
  ).toMatchObject({ value: { state: "reviewing" } });
});

test("a close or a skip ends the request and starts the cleanup, except under a live effect", () => {
  for (const state of ["queued", "reviewing", "watching", "approved", "posting"]) {
    expect(decideReview(facts("close", { state, launchState: "running" }))).toMatchObject({
      value: { state: "closed", ended: true, cleanup: true, lease: "hold" },
    });
    expect(decideReview(facts("skip", { state, launchState: "running" }))).toMatchObject({
      value: { state: "skipped", ended: true, cleanup: true },
    });
  }
  expect(
    decideReview(facts("skip", { state: "posting", launchState: null }, { ownerActive: true })),
  ).toMatchObject({ error: { reason: "review_post_in_progress" } });
  expect(
    decideReview(
      facts("close", { state: "queued", launchState: "starting" }, { ownerActive: true }),
    ),
  ).toMatchObject({ error: { reason: "review_start_in_progress" } });
  expect(decideReview(facts("skip", null))).toMatchObject({
    error: { reason: "review_request_missing" },
  });
  expect(decideReview(facts("skip", queued, { registered: false }))).toMatchObject({
    error: { reason: "review_repository_unregistered" },
  });
});

test("next rows show replacements, moves, approval, and unfinished cleanups", () => {
  expect(reviewAction({ state: "reviewing", launchState: "interrupted" }, false)).toEqual({
    kind: "action",
    action: "replace_reviewer",
    reason: "reviewer_interrupted",
  });
  expect(reviewAction({ state: "reviewing", launchState: "failed" }, false)).toMatchObject({
    action: "replace_reviewer",
    reason: "launch_failed",
  });
  expect(reviewAction({ state: "reviewing", launchState: "starting" }, false)).toMatchObject({
    action: "replace_reviewer",
    reason: "launch_abandoned",
  });
  expect(reviewAction({ state: "reviewing", launchState: "starting" }, true)).toEqual({
    kind: "wait",
    reason: "reviewer_starting",
  });
  const moving = { state: "reviewing", launchState: "running", sync: "{}" };
  expect(reviewAction(moving, true)).toEqual({ kind: "wait", reason: "reviewer_moving" });
  expect(reviewAction(moving, false)).toEqual({
    kind: "action",
    action: "wait_reviews",
    reason: "reviewer_move_unfinished",
  });
  // A watching request with a stopped reviewer waits for a round before it needs a replacement.
  expect(reviewAction({ state: "watching", launchState: "interrupted" }, false)).toEqual({
    kind: "wait",
    reason: "review_watching",
  });
  expect(reviewAction({ state: "approved", launchState: "running" }, false)).toEqual({
    kind: "wait",
    reason: "review_approved",
  });
  // A released reviewer of an approved request shows its unfinished cleanup.
  const approved = { state: "approved", launchState: "interrupted" };
  expect(reviewAction({ ...approved, cleanupState: "done" }, false)).toEqual({
    kind: "wait",
    reason: "review_approved",
  });
  expect(reviewAction({ ...approved, cleanupState: "failed" }, false)).toEqual({
    kind: "action",
    action: "clean_reviewer",
    reason: "cleanup_failed",
  });
  expect(reviewAction({ ...approved, cleanupState: "pending" }, false)).toEqual({
    kind: "action",
    action: "clean_reviewer",
    reason: "cleanup_pending",
  });
  expect(reviewAction({ ...approved, cleanupState: "pending" }, true)).toEqual({
    kind: "wait",
    reason: "reviewer_cleanup",
  });
  expect(reviewAction({ ...approved, cleanupState: "kept" }, false)).toEqual({
    kind: "attention",
    reason: "reviewer_work_kept",
  });
  const ended = { state: "closed", launchState: "running" };
  expect(reviewAction({ ...ended, cleanupState: "failed" }, false)).toEqual({
    kind: "action",
    action: "clean_reviewer",
    reason: "cleanup_failed",
  });
  expect(reviewAction({ ...ended, cleanupState: "pending" }, false)).toEqual({
    kind: "action",
    action: "clean_reviewer",
    reason: "cleanup_pending",
  });
  expect(reviewAction({ ...ended, cleanupState: "pending" }, true)).toEqual({
    kind: "wait",
    reason: "reviewer_cleanup",
  });
  expect(reviewAction({ ...ended, state: "skipped", cleanupState: "kept" }, false)).toEqual({
    kind: "attention",
    reason: "reviewer_work_kept",
  });
});

test("a cleanup of an open request holds it against a start and an end", () => {
  const cleaning = { state: "approved", launchState: "interrupted", cleanupState: "pending" };
  for (const ownerActive of [true, false])
    expect<unknown>(decideReview(facts("start", cleaning, { ownerActive }))).toEqual({
      tag: "Err",
      error: {
        reason: "review_cleanup_in_progress",
        detail:
          "The reviewer cleanup of this request has not finished. Start the reviewer after operator review wait or operator review cleanup finishes it. Nothing changed.",
      },
    });
  // A live cleanup holds the pane and the worktree, so the request cannot end under it.
  for (const command of ["close", "skip"] as const) {
    expect(decideReview(facts(command, cleaning, { ownerActive: true }))).toMatchObject({
      error: { reason: "review_cleanup_in_progress" },
    });
    // A cleanup whose process stopped is repeated by the end's own cleanup.
    expect(decideReview(facts(command, cleaning))).toMatchObject({
      value: { ended: true, cleanup: true, lease: "hold" },
    });
  }
  expect(decideReview(facts("start", { ...cleaning, cleanupState: "done" }))).toMatchObject({
    value: { launchState: "starting", replace: true },
  });
});

test("kept reviewer work stays with the person, so a renewal gets no replacement until a cleanup", () => {
  const kept = { state: "reviewing", launchState: "interrupted", cleanupState: "kept" };
  expect<unknown>(decideReview(facts("start", kept))).toEqual({
    tag: "Err",
    error: {
      reason: "reviewer_work_kept",
      detail:
        "The reviewer worktree holds unlanded work. Ask the person. Only the person deletes it, then run operator review cleanup. Nothing changed.",
    },
  });
  expect(reviewAction(kept, false)).toEqual({ kind: "attention", reason: "reviewer_work_kept" });
  // A renewal still moves the request.
  expect(
    decideReview(facts("round", { ...kept, state: "approved" }, { trigger: "re-request" })),
  ).toMatchObject({ value: { state: "reviewing", round: "re-request" } });
});

test("a live reviewer move holds the request, and only its own process finishes it", () => {
  const moving = { state: "reviewing", launchState: "running", sync: "{}" };
  for (const command of ["skip", "close"] as const)
    expect(decideReview(facts(command, moving, { ownerActive: true }))).toMatchObject({
      error: { reason: "review_reviewer_moving" },
    });
  expect(decideReview(facts("skip", moving))).toMatchObject({ value: { state: "skipped" } });
  expect(decideReview(facts("synced", moving, { ownLease: true }))).toMatchObject({
    value: { lease: "release" },
  });
  expect(decideReview(facts("synced", moving))).toMatchObject({
    error: { reason: "review_lease_lost" },
  });
  expect(
    decideReview(facts("synced", { ...moving, state: "skipped" }, { ownLease: true })),
  ).toMatchObject({ error: { reason: "review_lease_lost" } });
});

test("a round waits while a live start places the worktree", () => {
  const starting = { state: "watching", launchState: "starting" };
  expect(
    decideReview(facts("round", starting, { ownerActive: true, trigger: "commits" })),
  ).toMatchObject({ value: { unchanged: true } });
  expect(decideReview(facts("round", starting, { trigger: "commits" }))).toMatchObject({
    value: { state: "queued", round: "commits" },
  });
});

function refusal(input: ReviewFacts) {
  const decided = decideReview(input);
  return decided.tag === "Err" ? decided.error : null;
}

test("each refusal states its cause and that nothing changed", () => {
  const reviewing = { state: "reviewing", launchState: "running" };
  const starting = { state: "queued", launchState: "starting" };
  const cases: [ReviewFacts, string, string][] = [
    [
      facts("add", null, { registered: false }),
      "review_repository_unregistered",
      "The PR repository is not a registered project on this device. Register its controlling checkout first.",
    ],
    [facts("start", null), "review_request_missing", "Add the review request first."],
    [
      facts("close", starting, { ownerActive: true }),
      "review_start_in_progress",
      "Wait until the reviewer start ends.",
    ],
    [
      facts("close", { state: "posting", launchState: "running" }, { ownerActive: true }),
      "review_post_in_progress",
      "Another process posts this review now. Wait for it.",
    ],
    [
      facts("close", { ...reviewing, sync: "{}" }, { ownerActive: true }),
      "review_reviewer_moving",
      "A wait moves or prompts the reviewer now. End the request after it finishes.",
    ],
    [
      facts("start", starting, { ownerActive: true }),
      "review_start_in_progress",
      "Another process starts this reviewer.",
    ],
    [
      facts("start", reviewing),
      "review_reviewer_started",
      "This review request already has its reviewer, and the reviewer has not stopped.",
    ],
    [
      facts("started", reviewing),
      "review_start_interrupted",
      "The reviewer start is no longer recorded as running.",
    ],
    [
      facts("post", starting, { ownerActive: true }),
      "review_start_in_progress",
      "Wait until the reviewer start ends.",
    ],
    [
      facts("post", { state: "posting", launchState: "running" }, { ownerActive: true }),
      "review_post_in_progress",
      "Another process posts this review now. Do not repeat it.",
    ],
    [
      facts("post", { ...reviewing, sync: "{}" }, { ownerActive: true }),
      "review_reviewer_moving",
      "A wait moves the reviewer to the new PR head now. Post after the reviewer gets it.",
    ],
    [
      facts("post", { state: "watching", launchState: "running" }),
      "review_already_posted",
      "This review request is watching, so its review is already posted.",
    ],
    [
      facts("posted", reviewing, { event: "APPROVE" }),
      "review_post_interrupted",
      "The post is no longer recorded.",
    ],
    [
      facts("synced", { state: "closed", launchState: "running" }, { ownLease: true }),
      "review_lease_lost",
      "Another process took this review request during the move.",
    ],
  ];
  for (const [input, reason, detail] of cases)
    expect(refusal(input), reason).toEqual({ reason, detail: `${detail} Nothing changed.` });
});

test("commands that a running effect finishes decide for a missing request without a defect", () => {
  expect(refusal(facts("started", null))).toMatchObject({ reason: "review_start_interrupted" });
  expect(refusal(facts("posted", null))).toMatchObject({ reason: "review_post_interrupted" });
  expect(decideReview(facts("post_failed", null))).toMatchObject({
    tag: "Ok",
    value: { state: "queued", lease: "release" },
  });
  expect(
    decideReview(facts("post_failed", { state: "posting", launchState: "running" })),
  ).toMatchObject({ tag: "Ok", value: { state: "reviewing", lease: "release" } });
  expect(decideReview(facts("sync", null))).toMatchObject({
    tag: "Ok",
    value: { unchanged: true },
  });
  expect(decideReview(facts("synced", null, { ownLease: true }))).toMatchObject({
    tag: "Ok",
    value: { lease: "release" },
  });
});

test("a live owner with no running move neither blocks an end nor a post", () => {
  const reviewing = { state: "reviewing", launchState: "running" };
  expect(decideReview(facts("close", reviewing, { ownerActive: true }))).toMatchObject({
    tag: "Ok",
    value: { state: "closed" },
  });
  expect(decideReview(facts("post", reviewing, { ownerActive: true }))).toMatchObject({
    tag: "Ok",
    value: { state: "posting" },
  });
  expect(decideReview(facts("post", { ...reviewing, sync: "{}" }))).toMatchObject({
    tag: "Ok",
    value: { state: "posting" },
  });
});

test("an approved request starts a round only for a renewed request, and a round defaults to commits", () => {
  const approved = { state: "approved", launchState: "interrupted" };
  expect(decideReview(facts("round", approved, { trigger: "re-request" }))).toMatchObject({
    tag: "Ok",
    value: { state: "reviewing", round: "re-request" },
  });
  expect(decideReview(facts("round", approved, { trigger: "commits" }))).toMatchObject({
    tag: "Ok",
    value: { unchanged: true },
  });
  expect(
    decideReview(facts("round", { state: "watching", launchState: "interrupted" })),
  ).toMatchObject({ tag: "Ok", value: { round: "commits" } });
});

test("next asks for the failed cleanup even while an owner runs, and starts an abandoned start", () => {
  expect(
    reviewAction({ state: "closed", launchState: null, cleanupState: "failed" }, true),
  ).toEqual({
    kind: "action",
    action: "clean_reviewer",
    reason: "cleanup_failed",
  });
  expect(reviewAction({ state: "queued", launchState: "starting" }, false)).toEqual({
    kind: "action",
    action: "start_reviewer",
    reason: "launch_abandoned",
  });
  expect(reviewAction({ state: "reviewing", launchState: "starting" }, false)).toEqual({
    kind: "action",
    action: "replace_reviewer",
    reason: "launch_abandoned",
  });
  expect(reviewAction({ state: "other", launchState: null }, false)).toEqual({
    kind: "attention",
    reason: "review_state_unknown",
  });
});

test("a renewed request starts no round for a request that is still under review", () => {
  expect(
    decideReview(
      facts("round", { state: "reviewing", launchState: "running" }, { trigger: "re-request" }),
    ),
  ).toMatchObject({ tag: "Ok", value: { unchanged: true } });
});
