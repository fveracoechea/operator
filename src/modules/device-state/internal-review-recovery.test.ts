import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { migrationsFolder } from "./database.ts";
import { insertRow, reservedCopy, busy } from "./state-fixture.ts";
import { recoverInternalReview, readInternalReviewRecovery } from "./internal-review-recovery.ts";

const input = {
  repository: "owner/repo",
  sourceId: "source",
  assignment: "build",
  launchId: "implementer",
  number: 416,
  url: "https://github.com/owner/repo/pull/416",
  branch: "task/build",
  worktreePath: "/isolated/build",
  head: "abc123",
  personInstructed: true,
};

function fixture() {
  const client = new Database(":memory:");
  migrate(drizzle(client), { migrationsFolder });
  insertRow(client, "projects", { repository: input.repository, checkout: "/checkout" });
  insertRow(client, "sources", { id: input.sourceId, repository: input.repository, state: "open" });
  insertRow(client, "assignments", {
    source_id: input.sourceId,
    key: "report",
    completion: "report",
    state: "completed",
  });
  insertRow(client, "assignments", {
    source_id: input.sourceId,
    key: input.assignment,
    completion: "pr",
    state: "pr-open",
  });
  insertRow(client, "launches", {
    id: input.launchId,
    source_id: input.sourceId,
    assignment: input.assignment,
    attempt: 1,
    state: "running",
    branch: input.branch,
    worktree_path: input.worktreePath,
  });
  insertRow(client, "promotions", {
    source_id: input.sourceId,
    assignment: input.assignment,
    report: "report",
    branch: input.branch,
    worktree_path: input.worktreePath,
    handover_launch_id: input.launchId,
    internal_review: 1,
  });
  insertRow(client, "pull_requests", {
    source_id: input.sourceId,
    assignment: input.assignment,
    repository: input.repository,
    number: input.number,
    url: input.url,
    branch: input.branch,
  });
  return client;
}

test("recovery records the attested provenance and a real pending handoff without rewriting the launch", () => {
  using client = fixture();
  const launch = client.query("SELECT * FROM launches").get();
  const before = Date.now();
  expect(recoverInternalReview(client, input)).toMatchObject({
    tag: "Ok",
    value: { changed: true },
  });
  const review = client.query<{ started_at: string }, []>("SELECT * FROM internal_reviews").get();
  expect(review).toMatchObject({
    state: "reviewing",
    implementer_launch_id: "implementer",
    handoff_state: "pending",
    owner_pid: process.pid,
    ready_head: null,
    ended_at: null,
  });
  expect(Date.parse(review?.started_at ?? "")).toBeGreaterThanOrEqual(before);
  expect(client.query("SELECT * FROM launches").get()).toEqual(launch);
  expect(client.query("SELECT * FROM internal_review_rounds").all()).toEqual([]);
  expect(
    readInternalReviewRecovery(client, input.repository, input.sourceId, input.assignment),
  ).toMatchObject({
    tag: "Ok",
    value: { implementerLaunchId: input.launchId, head: input.head, personInstructed: true },
  });
  const recovered = client.serialize();
  expect(recoverInternalReview(client, input)).toMatchObject({
    tag: "Ok",
    value: { changed: false },
  });
  expect(client.serialize()).toEqual(recovered);
});

test("an audited retry preserves reviewer ownership, rounds, and external review requests", () => {
  using client = fixture();
  insertRow(client, "review_requests", {
    id: "external",
    repository: input.repository,
    number: input.number,
    url: input.url,
    origin: "assignment",
    source_id: input.sourceId,
    assignment: input.assignment,
    state: "requested",
  });
  const external = client.query("SELECT * FROM review_requests").all();
  expect(recoverInternalReview(client, input)).toMatchObject({
    tag: "Ok",
    value: { changed: true },
  });
  expect(client.query("SELECT * FROM review_requests").all()).toEqual(external);
  client.exec(
    "UPDATE launches SET state = 'finished'; UPDATE internal_reviews SET handoff_state = 'done', owner_pid = NULL, lease_at = NULL",
  );
  insertRow(client, "launches", {
    id: "reviewer",
    source_id: input.sourceId,
    assignment: input.assignment,
    attempt: 2,
    state: "running",
    internal_review: 1,
    worktree_path: input.worktreePath,
  });
  insertRow(client, "internal_review_rounds", {
    source_id: input.sourceId,
    assignment: input.assignment,
    number: 1,
    launch_id: "reviewer",
    head: "new-head",
    findings: "[]",
  });
  const before = client.serialize();
  expect(recoverInternalReview(client, input)).toMatchObject({
    tag: "Ok",
    value: { changed: false },
  });
  expect(client.serialize()).toEqual(before);
  expect(recoverInternalReview(client, { ...input, head: "different" })).toMatchObject({
    tag: "Err",
    error: { reason: "internal_review_recovery_incompatible" },
  });
  expect(client.serialize()).toEqual(before);
});

test("missing instruction refuses without a write and the writer reservation precedes all checks", () => {
  using client = fixture();
  const before = client.serialize();
  expect(
    readInternalReviewRecovery(client, input.repository, input.sourceId, input.assignment),
  ).toMatchObject({ tag: "Ok", value: null });
  expect(recoverInternalReview(client, { ...input, personInstructed: false })).toMatchObject({
    tag: "Err",
    error: {
      reason: "person_instruction_required",
      detail:
        "Internal review recovery requires the person's explicit instruction. Nothing was changed.",
      next: {
        command: "operator next",
        why: "Ask the person before recovering an internal review.",
      },
    },
  });
  expect(client.serialize()).toEqual(before);
  using locked = reservedCopy(client);
  expect(
    readInternalReviewRecovery(locked.subject, input.repository, input.sourceId, input.assignment),
  ).toMatchObject({ tag: "Ok", value: null });
  expect(recoverInternalReview(locked.subject, input)).toMatchObject(busy);
});

test.each([
  ["source closed", "UPDATE sources SET state = 'reset'"],
  ["source repository", "UPDATE sources SET repository = 'different/repo'"],
  ["assignment ended", "UPDATE assignments SET state = 'completed' WHERE key = 'build'"],
  ["completion", "UPDATE assignments SET completion = 'report' WHERE key = 'build'"],
  ["promotion missing", "DELETE FROM promotions"],
  ["promotion launch", "UPDATE promotions SET handover_launch_id = NULL"],
  ["promotion branch", "UPDATE promotions SET branch = 'different'"],
  ["promotion worktree", "UPDATE promotions SET worktree_path = '/different'"],
  [
    "explicit opt out",
    "UPDATE promotions SET internal_review = 0; UPDATE sources SET plan = '{\"internalReview\":true}'",
  ],
  [
    "ambiguous policy",
    "UPDATE promotions SET internal_review = NULL; UPDATE sources SET plan = '{}'",
  ],
  [
    "invalid policy",
    "UPDATE promotions SET internal_review = NULL; UPDATE sources SET plan = 'invalid'",
  ],
  [
    "plan opt out",
    "UPDATE promotions SET internal_review = NULL; UPDATE sources SET plan = '{\"internalReview\":false}'",
  ],
  ["launch stopped", "UPDATE launches SET state = 'finished'"],
  ["launch snapshot true", "UPDATE launches SET internal_review = 1"],
  ["launch snapshot false", "UPDATE launches SET internal_review = 0"],
  ["launch branch", "UPDATE launches SET branch = 'different'"],
  ["launch worktree", "UPDATE launches SET worktree_path = '/different'"],
  ["PR repository", "UPDATE pull_requests SET repository = 'different/repo'"],
  ["PR number", "UPDATE pull_requests SET number = 1"],
  ["PR url", "UPDATE pull_requests SET url = 'different'"],
  ["PR branch", "UPDATE pull_requests SET branch = 'different'"],
  ["PR merged time", "UPDATE pull_requests SET merged_at = 'now'"],
  ["PR merged head", "UPDATE pull_requests SET merged_head = 'head'"],
  ["PR merge commit", "UPDATE pull_requests SET merge_commit = 'head'"],
])("%s refuses without changing any records", (_name, sql) => {
  using client = fixture();
  client.exec(sql);
  const before = client.serialize();
  expect(recoverInternalReview(client, input)).toMatchObject({
    tag: "Err",
    error: {
      reason: "internal_review_recovery_incompatible",
      detail:
        "The recorded assignment does not match the promoted internal review recovery. Nothing was changed.",
      next: {
        command: "operator next",
        why: "Read the assignment's current state before choosing another action.",
      },
    },
  });
  expect(client.serialize()).toEqual(before);
});

test.each(["starting", "running"])(
  "a different latest %s launch claiming the recorded worktree refuses fresh recovery and retry",
  (state) => {
    for (const retry of [false, true]) {
      using client = fixture();
      if (retry) expect(recoverInternalReview(client, input)).toMatchObject({ tag: "Ok" });
      insertRow(client, "launches", {
        id: "collision",
        source_id: input.sourceId,
        assignment: "report",
        attempt: 1,
        state,
        worktree_path: input.worktreePath,
      });
      const before = client.serialize();
      expect(recoverInternalReview(client, input)).toMatchObject({
        tag: "Err",
        error: { reason: "internal_review_recovery_incompatible" },
      });
      expect(client.serialize()).toEqual(before);
    }
  },
);

test.each(["finished prior implementer", "superseded running", "closed source", "different path"])(
  "inactive or unrelated worktree records do not prevent recovery: %s",
  (scenario) => {
    using client = fixture();
    const prior = scenario === "finished prior implementer";
    if (prior) client.exec("UPDATE launches SET attempt = 2");
    let sourceId = input.sourceId;
    if (scenario === "closed source") {
      sourceId = "closed";
      insertRow(client, "sources", { id: sourceId, repository: input.repository, state: "reset" });
      insertRow(client, "assignments", {
        source_id: sourceId,
        key: "report",
        completion: "report",
        state: "completed",
      });
    }
    insertRow(client, "launches", {
      id: "other",
      source_id: sourceId,
      assignment: prior ? input.assignment : "report",
      attempt: 1,
      state: prior ? "finished" : "running",
      worktree_path: scenario === "different path" ? "/isolated/other" : input.worktreePath,
    });
    if (scenario === "superseded running")
      insertRow(client, "launches", {
        id: "latest",
        source_id: sourceId,
        assignment: "report",
        attempt: 2,
        state: "finished",
      });
    expect(recoverInternalReview(client, input)).toMatchObject({
      tag: "Ok",
      value: { changed: true },
    });
  },
);

test("an active collision in another open source also refuses without a write", () => {
  using client = fixture();
  insertRow(client, "sources", { id: "other-source", repository: input.repository, state: "open" });
  insertRow(client, "assignments", {
    source_id: "other-source",
    key: input.assignment,
    completion: "pr",
    state: "running",
  });
  insertRow(client, "launches", {
    id: "other-source-launch",
    source_id: "other-source",
    assignment: input.assignment,
    attempt: 1,
    state: "running",
    worktree_path: input.worktreePath,
  });
  const before = client.serialize();
  expect(recoverInternalReview(client, input)).toMatchObject({
    tag: "Err",
    error: { reason: "internal_review_recovery_incompatible" },
  });
  expect(client.serialize()).toEqual(before);
});

test("the explicit plan policy can prove review was required, but promotion opt-out wins", () => {
  using client = fixture();
  client.exec(
    "UPDATE promotions SET internal_review = NULL; UPDATE sources SET plan = '{\"internalReview\":true}'",
  );
  expect(recoverInternalReview(client, input)).toMatchObject({
    tag: "Ok",
    value: { changed: true },
  });
});

test.each(["number", "url"])(
  "ambiguous PR ownership by %s refuses even when the other assignment ended",
  (identity) => {
    using client = fixture();
    insertRow(client, "pull_requests", {
      source_id: input.sourceId,
      assignment: "report",
      repository: input.repository,
      number: identity === "number" ? input.number : 10,
      url: identity === "url" ? input.url : "different",
      branch: "different",
    });
    const before = client.serialize();
    expect(recoverInternalReview(client, input)).toMatchObject({
      tag: "Err",
      error: { reason: "internal_review_recovery_incompatible" },
    });
    expect(client.serialize()).toEqual(before);
  },
);

test("a newer launch and an unaudited existing review each refuse recovery", () => {
  using client = fixture();
  insertRow(client, "launches", {
    id: "newer",
    source_id: input.sourceId,
    assignment: input.assignment,
    attempt: 2,
    state: "running",
  });
  let before = client.serialize();
  expect(recoverInternalReview(client, input)).toMatchObject({
    tag: "Err",
    error: { reason: "internal_review_recovery_incompatible" },
  });
  expect(client.serialize()).toEqual(before);
  client.exec("DELETE FROM launches WHERE id = 'newer'");
  insertRow(client, "internal_reviews", {
    source_id: input.sourceId,
    assignment: input.assignment,
    implementer_launch_id: input.launchId,
    state: "reviewing",
    handoff_state: "pending",
  });
  before = client.serialize();
  expect(recoverInternalReview(client, input)).toMatchObject({
    tag: "Err",
    error: { reason: "internal_review_recovery_incompatible" },
  });
  expect(client.serialize()).toEqual(before);
});

test.each(["ready", "skipped"])("an audited retry refuses an already %s review", (state) => {
  using client = fixture();
  expect(recoverInternalReview(client, input)).toMatchObject({ tag: "Ok" });
  client.query("UPDATE internal_reviews SET state = ?").run(state);
  const before = client.serialize();
  expect(recoverInternalReview(client, input)).toMatchObject({
    tag: "Err",
    error: { reason: "internal_review_recovery_incompatible" },
  });
  expect(client.serialize()).toEqual(before);
});

test("review and audit writes roll back together if insertion fails", () => {
  using client = fixture();
  client.exec(
    "CREATE TRIGGER reject_review BEFORE INSERT ON internal_reviews BEGIN SELECT RAISE(ABORT, 'test refusal'); END",
  );
  const before = client.serialize();
  expect(recoverInternalReview(client, input)).toMatchObject({ tag: "Defect" });
  expect(client.serialize()).toEqual(before);
});

test("orphaned review round history refuses rather than inventing a new review", () => {
  using client = fixture();
  insertRow(client, "internal_review_rounds", {
    source_id: input.sourceId,
    assignment: input.assignment,
    number: 1,
    launch_id: input.launchId,
    head: "old",
    findings: "[]",
  });
  const before = client.serialize();
  expect(recoverInternalReview(client, input)).toMatchObject({
    tag: "Err",
    error: { reason: "internal_review_recovery_incompatible" },
  });
  expect(client.serialize()).toEqual(before);
});
