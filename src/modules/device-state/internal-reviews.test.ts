import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { migrationsFolder } from "./database.ts";
import { claimHandoff, endInternalReview, recordInternalReviewRound } from "./internal-reviews.ts";
import { Ok } from "unthrown";
import { projects, sources, assignments, launches, internalReviews } from "./schema.ts";
import { insertRow } from "./state-fixture.ts";

test("review completion atomically retains dispositions and queues the recorded feedback successor", () => {
  using client = new Database(":memory:");
  migrate(drizzle(client), { migrationsFolder });
  insertRow(client, "sources", { id: "s", repository: "owner/repo", state: "open" });
  insertRow(client, "assignments", {
    source_id: "s",
    key: "a",
    completion: "pr",
    state: "pr-open",
  });
  insertRow(client, "launches", {
    id: "r",
    source_id: "s",
    assignment: "a",
    attempt: 2,
    state: "running",
  });
  insertRow(client, "pull_requests", { source_id: "s", assignment: "a", readiness: null });
  insertRow(client, "internal_reviews", {
    source_id: "s",
    assignment: "a",
    state: "reviewing",
    implementer_launch_id: "i",
    ready_head: null,
  });
  const readiness = {
    head: "h",
    at: "now",
    note: "/device/note.md",
    dispositions: [
      { round: 1, finding: 1, disposition: "declined" as const, reason: "Not a contract." },
    ],
  };
  expect(
    endInternalReview(
      client,
      { sourceId: "s", assignment: "a", launchId: "r" },
      {
        state: "ready",
        readyHead: "h",
        commentId: "c",
        commentUrl: "https://github.com/c",
        readiness,
      },
      false,
    ),
  ).toMatchObject({
    tag: "Ok",
    value: { changed: true, review: { readyHead: "h", commentUrl: "https://github.com/c" } },
  });
  expect(client.query("SELECT readiness FROM pull_requests").get()).toEqual({
    readiness: JSON.stringify(readiness),
  });
  expect(client.query("SELECT outgoing_launch_id, next_kind FROM kind_handoffs").get()).toEqual({
    outgoing_launch_id: "r",
    next_kind: "pr-feedback",
  });
  client.exec("UPDATE launches SET state = 'finished'");
  const before = client.serialize();
  expect(
    endInternalReview(
      client,
      { sourceId: "s", assignment: "a", launchId: "r" },
      {
        state: "ready",
        readyHead: "other",
        commentId: "c",
        commentUrl: "https://github.com/c",
        readiness,
      },
      false,
    ),
  ).toMatchObject({ tag: "Err", error: { reason: "pr_owner_inactive" } });
  expect(client.serialize()).toEqual(before);
});

test("a skipped review records readiness and queues feedback without rounds or a summary comment", () => {
  using client = new Database(":memory:");
  migrate(drizzle(client), { migrationsFolder });
  insertRow(client, "sources", { id: "s", repository: "owner/repo", state: "open" });
  insertRow(client, "assignments", {
    source_id: "s",
    key: "a",
    completion: "pr",
    state: "pr-open",
  });
  insertRow(client, "launches", {
    id: "r",
    source_id: "s",
    assignment: "a",
    attempt: 2,
    state: "running",
  });
  insertRow(client, "pull_requests", { source_id: "s", assignment: "a", readiness: null });
  insertRow(client, "internal_reviews", {
    source_id: "s",
    assignment: "a",
    state: "skipped",
    implementer_launch_id: "i",
    ready_head: null,
    comment_id: null,
    comment_url: null,
  });
  const readiness = {
    head: "pushed",
    at: "2026-11-20T00:00:00.000Z",
    note: "/device/ready-note.md",
    dispositions: [],
  };
  expect(
    endInternalReview(
      client,
      { sourceId: "s", assignment: "a", launchId: "r" },
      {
        state: "skipped",
        readyHead: "pushed",
        commentId: null,
        commentUrl: null,
        readiness,
      },
      false,
    ),
  ).toMatchObject({
    tag: "Ok",
    value: {
      changed: true,
      review: { state: "skipped", readyHead: "pushed", commentId: null, commentUrl: null },
    },
  });
  expect(
    client.query("SELECT state, ready_head, comment_id, comment_url FROM internal_reviews").get(),
  ).toEqual({ state: "skipped", ready_head: "pushed", comment_id: null, comment_url: null });
  expect(client.query("SELECT * FROM internal_review_rounds").all()).toEqual([]);
  expect(client.query("SELECT readiness FROM pull_requests").get()).toEqual({
    readiness: JSON.stringify(readiness),
  });
  expect(
    client
      .query("SELECT outgoing_launch_id, next_kind, handoff_state, started_at FROM kind_handoffs")
      .all(),
  ).toEqual([
    {
      outgoing_launch_id: "r",
      next_kind: "pr-feedback",
      handoff_state: "pending",
      started_at: "2026-11-20T00:00:00.000Z",
    },
  ]);
});

function reviewFixture(state: "reviewing" | "ready" | "skipped") {
  const client = new Database(":memory:");
  migrate(drizzle(client), { migrationsFolder });
  insertRow(client, "sources", { id: "s", repository: "owner/repo", state: "open" });
  insertRow(client, "assignments", {
    source_id: "s",
    key: "a",
    completion: "pr",
    state: "pr-open",
  });
  insertRow(client, "launches", {
    id: "r",
    source_id: "s",
    assignment: "a",
    attempt: 2,
    state: "running",
  });
  insertRow(client, "pull_requests", { source_id: "s", assignment: "a", readiness: null });
  insertRow(client, "internal_reviews", {
    source_id: "s",
    assignment: "a",
    state,
    implementer_launch_id: "i",
    ready_head: null,
  });
  return client;
}

const readiness = { head: "pushed", at: "2026-11-20T00:00:00.000Z", note: null, dispositions: [] };

test.each(["ready", "skipped"] as const)(
  "a %s review cannot reopen without the skipped-readiness exception",
  (state) => {
    using client = reviewFixture(state);
    const before = client.serialize();
    expect(
      endInternalReview(
        client,
        { sourceId: "s", assignment: "a", launchId: "r" },
        {
          state: "ready",
          readyHead: "pushed",
          commentId: null,
          commentUrl: null,
          readiness: state === "ready" ? readiness : undefined,
        },
        false,
      ),
    ).toMatchObject({ tag: "Err", error: { reason: "internal_review_ended" } });
    expect(client.serialize()).toEqual(before);
  },
);

test.each([
  ["r", false],
  [null, false],
  [null, true],
] as const)(
  "skip by launch %j with readiness %j records no ready receipt or feedback handoff",
  (launchId, supplied) => {
    using client = reviewFixture("reviewing");
    expect(
      endInternalReview(
        client,
        { sourceId: "s", assignment: "a", launchId },
        {
          state: "skipped",
          readyHead: "skip-head",
          commentId: null,
          commentUrl: null,
          readiness: supplied ? readiness : undefined,
        },
        false,
      ),
    ).toMatchObject({
      tag: "Ok",
      value: { changed: true, review: { state: "skipped", readyHead: "skip-head" } },
    });
    expect(client.query("SELECT readiness FROM pull_requests").get()).toEqual({ readiness: null });
    expect(client.query("SELECT * FROM kind_handoffs").all()).toEqual([]);
  },
);

test("a pending handoff refuses review completion and rolls back readiness and the review end", () => {
  using client = reviewFixture("reviewing");
  insertRow(client, "kind_handoffs", {
    source_id: "s",
    assignment: "a",
    outgoing_launch_id: "i",
    next_kind: "review",
    handoff_state: "pending",
  });
  const before = client.serialize();
  expect(
    endInternalReview(
      client,
      { sourceId: "s", assignment: "a", launchId: "r" },
      {
        state: "ready",
        readyHead: "pushed",
        commentId: null,
        commentUrl: null,
        readiness,
      },
      false,
    ),
  ).toMatchObject({ tag: "Err", error: { reason: "handoff_running" } });
  expect(client.serialize()).toEqual(before);
});

test("skip commit guards expose only checked facts and preserve the database on refusal", () => {
  using client = new Database(":memory:");
  const db = drizzle(client);
  migrate(db, { migrationsFolder });
  db.insert(projects)
    .values({ repository: "owner/repo", checkout: "/checkout", registeredAt: "now" })
    .run();
  db.insert(sources)
    .values({
      id: "s1",
      repository: "owner/repo",
      trackerKey: "issue",
      plan: "{}",
      state: "open",
      registeredAt: "now",
    })
    .run();
  db.insert(assignments)
    .values({ sourceId: "s1", key: "build", completion: "pr", state: "pr-open" })
    .run();
  const target = { sourceId: "s1", assignment: "build", launchId: null };
  const end = { state: "skipped" as const, readyHead: "h2", commentId: null, commentUrl: null };
  const missing = client.serialize();
  expect(endInternalReview(client, target, end, false)).toMatchObject({
    tag: "Err",
    error: {
      reason: "internal_review_not_recorded",
      next: { why: "No internal review exists to end." },
      state: { review: null },
    },
  });
  expect(client.serialize()).toEqual(missing);
  db.insert(launches)
    .values({
      id: "i",
      sourceId: "s1",
      assignment: "build",
      attempt: 1,
      name: "implementation",
      state: "finished",
      resources: "worktree",
      branch: "task/build",
      host: "opencode",
      model: "model",
      requestedModel: "model",
      reasoningEffort: "high",
      release: "{}",
      skills: "[]",
      startedAt: "now",
    })
    .run();
  db.insert(internalReviews)
    .values({
      sourceId: "s1",
      assignment: "build",
      state: "ready",
      implementerLaunchId: "i",
      handoffState: "done",
      startedAt: "now",
      updatedAt: "now",
      readyHead: "h1",
    })
    .run();
  const ended = client.serialize();
  expect(endInternalReview(client, target, end, false)).toMatchObject({
    tag: "Err",
    error: {
      reason: "internal_review_ended",
      next: { why: "The internal review has already ended. No transition remains." },
      state: { review: "ready" },
    },
  });
  expect(client.serialize()).toEqual(ended);
  client.exec("UPDATE sources SET state = 'reset'");
  const inactive = client.serialize();
  expect(endInternalReview(client, target, end, false)).toMatchObject({
    tag: "Err",
    error: {
      reason: "pr_owner_inactive",
      next: {
        command: "operator next",
        why: "Read the assignment's current action before ending its review.",
      },
      state: { source: "reset" },
    },
  });
  expect(client.serialize()).toEqual(inactive);
  client.exec("UPDATE sources SET state = 'open'; UPDATE assignments SET state = 'reported'");
  const wrongState = client.serialize();
  expect(endInternalReview(client, target, end, false)).toMatchObject({
    tag: "Err",
    error: {
      reason: "pr_owner_inactive",
      next: {
        command: "operator next",
        why: "Read the assignment's current action before ending its review.",
      },
      state: { assignment: "reported" },
    },
  });
  expect(client.serialize()).toEqual(wrongState);
  expect(endInternalReview(client, { ...target, assignment: "missing" }, end, false)).toMatchObject(
    {
      tag: "Err",
      error: {
        reason: "pr_owner_inactive",
        next: {
          command: "operator next",
          why: "Read the assignment's current action before ending its review.",
        },
        state: { openAssignmentFound: false },
      },
    },
  );
  expect(client.serialize()).toEqual(wrongState);
  expect(claimHandoff(client, "owner/repo", "missing", "build", null)).toMatchObject({
    tag: "Err",
    error: {
      reason: "source_not_found",
      next: { command: "operator next", why: "Choose an existing source in this project." },
    },
  });
  expect(claimHandoff(client, "owner/repo", "s1", "missing", null)).toMatchObject({
    tag: "Err",
    error: {
      reason: "handoff_not_found",
      next: {
        command: "operator next",
        why: "Read the assignment's handoff state before retrying.",
      },
    },
  });
  expect(client.serialize()).toEqual(wrongState);
  client
    .query(
      "INSERT INTO kind_handoffs (source_id, assignment, outgoing_launch_id, next_kind, handoff_state, started_at, updated_at, owner_pid, lease_at) VALUES ('s1', 'build', 'i', 'review', 'pending', 'now', 'now', ?, ?)",
    )
    .run(process.ppid, new Date().toISOString());
  const held = client.serialize();
  expect(claimHandoff(client, "owner/repo", "s1", "build", null)).toMatchObject({
    tag: "Err",
    error: {
      reason: "handoff_running",
      next: {
        command: "operator next --wait",
        why: "Let the recorded handoff finish before retrying.",
      },
    },
  });
  expect(client.serialize()).toEqual(held);
  client.exec(
    "UPDATE assignments SET state = 'pr-open'; UPDATE launches SET state = 'running'; DELETE FROM internal_reviews",
  );
  const beforeRound = client.serialize();
  let decisions = 0;
  expect(
    recordInternalReviewRound(client, "i", () => {
      decisions++;
      return Ok({ head: "h1", findings: "[]" });
    }),
  ).toMatchObject({
    tag: "Err",
    error: {
      reason: "internal_review_not_recorded",
      next: { command: "operator next", why: "Read the assignment's recorded review state." },
    },
  });
  expect(decisions).toBe(0);
  expect(client.serialize()).toEqual(beforeRound);
});
