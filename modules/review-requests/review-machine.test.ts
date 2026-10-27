import { expect, test } from "bun:test";
import { decideReview, reviewAction, type ReviewCommand } from "./review-machine.ts";

function facts(
  command: ReviewCommand,
  request: { state: string; launchState: string | null } | null,
  change: { registered?: boolean; ownerActive?: boolean; event?: string } = {},
) {
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
  expect(decideReview(facts("posted", posting, { event: "APPROVE" }))).toMatchObject({
    value: { state: "approved", ended: true, lease: "release" },
  });
  for (const event of ["COMMENT", "REQUEST_CHANGES"])
    expect(decideReview(facts("posted", posting, { event }))).toMatchObject({
      value: { state: "watching", lease: "release" },
    });
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
  expect(decideReview(facts("post_uncertain", posting))).toEqual({
    tag: "Ok",
    value: { lease: "release" },
  } as never);
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
