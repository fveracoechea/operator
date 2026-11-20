import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { migrationsFolder } from "./database.ts";
import {
  claimHandoff,
  endInternalReview,
  failHandoff,
  finishHandoff,
  finishImplementer,
  handoffDispatchable,
  recordInternalReviewRound,
  renewHandoff,
  startHandoff,
} from "./internal-reviews.ts";
import { Ok } from "unthrown";
import { projects, sources, assignments, launches, internalReviews } from "./schema.ts";
import { continuation, handoffWriteFixture } from "./handoff-write-fixture.ts";

const handoffWriters = [
  {
    name: "claim",
    write: (client: Database, identity: typeof continuation) =>
      claimHandoff(client, "owner/repo", "s1", "build", null, identity),
  },
  {
    name: "renew",
    write: (client: Database, identity: typeof continuation) =>
      renewHandoff(client, "s1", "build", identity),
  },
  {
    name: "fail",
    write: (client: Database, identity: typeof continuation) =>
      failHandoff(client, "s1", "build", "controlled failure", identity),
  },
  {
    name: "finish implementer",
    write: (client: Database, identity: typeof continuation) =>
      finishImplementer(client, "implementer", identity),
  },
];

test.each(handoffWriters)("$name refuses a changed continuation without any write", ({ write }) => {
  using client = handoffWriteFixture();
  const before = client.serialize();
  expect(write(client, { ...continuation, startedAt: "different" })).toMatchObject({
    tag: "Err",
    error: { reason: "handoff_continuation_refused", state: { continuationAuthorized: false } },
  });
  expect(client.serialize()).toEqual(before);
});

test.each(handoffWriters)(
  "$name preserves supervision for an authorized continuation",
  ({ write }) => {
    using client = handoffWriteFixture();
    expect(write(client, continuation).tag).toBe("Ok");
    expect(client.query("SELECT supervising_pane, supervising_session FROM sources").get()).toEqual(
      { supervising_pane: "supervisor", supervising_session: "ses_supervisor" },
    );
  },
);

test("an authorized claim records its hold and returns the outgoing launch and checkout", () => {
  using client = handoffWriteFixture();
  client.exec("UPDATE kind_handoffs SET handoff_detail = 'previous attempt'");
  expect(claimHandoff(client, "owner/repo", "s1", "build", null, continuation)).toMatchObject({
    tag: "Ok",
    value: {
      checkout: "/checkout",
      implementer: { id: "implementer", state: "running" },
      latest: { id: "implementer", attempt: 1 },
      handoff: {
        handoffState: "pending",
        handoffDetail: null,
        ownerPid: process.pid,
        outgoingLaunchId: "implementer",
        nextKind: "review",
        startedAt: "2026-11-17T00:00:00.000Z",
      },
    },
  });
  expect(
    client
      .query(
        "SELECT handoff_state, handoff_detail, owner_pid, updated_at = lease_at AS held FROM kind_handoffs",
      )
      .get(),
  ).toEqual({ handoff_state: "pending", handoff_detail: null, owner_pid: process.pid, held: 1 });
});

test("an authorized renewal extends only the handoff lease", () => {
  using client = handoffWriteFixture();
  const before = client.query<{ lease_at: string }, []>("SELECT lease_at FROM kind_handoffs").get();
  expect(renewHandoff(client, "s1", "build", continuation).tag).toBe("Ok");
  const after = client.query<{ lease_at: string }, []>("SELECT lease_at FROM kind_handoffs").get();
  expect(after?.lease_at).not.toBe(before?.lease_at);
  expect(
    client.query("SELECT handoff_state, updated_at, owner_pid FROM kind_handoffs").get(),
  ).toEqual({
    handoff_state: "pending",
    updated_at: "before",
    owner_pid: process.pid,
  });
  expect(client.query("SELECT state, ended_at FROM launches").get()).toEqual({
    state: "running",
    ended_at: null,
  });
});

test("an authorized failure records its reason and releases the handoff hold", () => {
  using client = handoffWriteFixture();
  expect(failHandoff(client, "s1", "build", "controlled failure", continuation).tag).toBe("Ok");
  expect(
    client
      .query(
        "SELECT handoff_state, handoff_detail, owner_pid, lease_at, updated_at != 'before' AS updated FROM kind_handoffs",
      )
      .get(),
  ).toEqual({
    handoff_state: "failed",
    handoff_detail: "controlled failure",
    owner_pid: null,
    lease_at: null,
    updated: 1,
  });
  expect(client.query("SELECT state, ended_at FROM launches").get()).toEqual({
    state: "running",
    ended_at: null,
  });
});

test.each(["running", "interrupted"])(
  "an authorized finish ends a %s implementer and clears interruption details",
  (state) => {
    using client = handoffWriteFixture();
    client
      .query(
        "UPDATE launches SET state = ?, failure_reason = 'pane_ended', failure_detail = 'pane closed'",
      )
      .run(state);
    const handoff = client.query("SELECT * FROM kind_handoffs").get();
    expect(finishImplementer(client, "implementer", continuation).tag).toBe("Ok");
    expect(
      client
        .query(
          "SELECT state, ended_at IS NOT NULL AS ended, failure_reason, failure_detail FROM launches",
        )
        .get(),
    ).toEqual({
      state: "finished",
      ended: 1,
      failure_reason: null,
      failure_detail: null,
    });
    expect(client.query("SELECT * FROM kind_handoffs").get()).toEqual(handoff);
  },
);

test.each(["pending", "failed", "done"])(
  "finishing a %s handoff changes only the named unfinished hold",
  (state) => {
    using client = handoffWriteFixture();
    client
      .query("UPDATE kind_handoffs SET handoff_state = ?, handoff_detail = 'previous attempt'")
      .run(state);
    const db = drizzle(client);
    db.insert(assignments)
      .values({ sourceId: "s1", key: "other", completion: "pr", state: "pr-open" })
      .run();
    client.exec(
      "INSERT INTO kind_handoffs SELECT source_id, 'other', outgoing_launch_id, next_kind, handoff_state, handoff_detail, started_at, updated_at, owner_pid, lease_at FROM kind_handoffs",
    );
    const before = client.query("SELECT * FROM kind_handoffs ORDER BY assignment").all();
    finishHandoff(db, "s1", "build");
    const after = client.query("SELECT * FROM kind_handoffs ORDER BY assignment").all();
    expect(after[1]).toEqual(before[1]);
    if (state === "done") expect(after[0]).toEqual(before[0]);
    else
      expect(after[0]).toMatchObject({
        source_id: "s1",
        assignment: "build",
        handoff_state: "done",
        handoff_detail: null,
        owner_pid: null,
        lease_at: null,
      });
  },
);

test.each([
  ["own hold", "", true],
  ["no handoff", "DELETE FROM kind_handoffs", false],
  ["other outgoing", "other", false],
  ["done", "UPDATE kind_handoffs SET handoff_state = 'done'", false],
  ["failed", "UPDATE kind_handoffs SET handoff_state = 'failed'", true],
  ["foreign fresh hold", "foreign", false],
  ["foreign stale hold", "stale", true],
] as const)("handoff dispatchability checks %s", (_name, change, allowed) => {
  using client = handoffWriteFixture();
  client.exec("UPDATE launches SET state = 'finished'");
  if (change === "foreign" || change === "stale") {
    client.query("UPDATE kind_handoffs SET owner_pid = ?").run(process.ppid);
    if (change === "stale") client.exec("UPDATE kind_handoffs SET lease_at = '2000-01-01'");
  } else if (change !== "" && change !== "other") client.exec(change);
  const db = drizzle(client);
  const latest = db.select().from(launches).get();
  expect(
    handoffDispatchable(
      db,
      change === "other" && latest !== undefined ? { ...latest, id: "other" } : latest,
      Date.now(),
    ),
  ).toBe(allowed);
  expect(handoffDispatchable(db, undefined, Date.now())).toBe(false);
  if (latest !== undefined)
    expect(handoffDispatchable(db, { ...latest, state: "running" }, Date.now())).toBe(false);
});

test("a completed handoff is returned without a new claim or any write", () => {
  using client = handoffWriteFixture();
  client.exec(
    "UPDATE kind_handoffs SET handoff_state = 'done', handoff_detail = 'keep', owner_pid = NULL, lease_at = NULL",
  );
  const before = client.serialize();
  expect(claimHandoff(client, "owner/repo", "s1", "build", null)).toMatchObject({
    tag: "Ok",
    value: {
      checkout: "/checkout",
      implementer: { id: "implementer" },
      latest: { id: "implementer" },
      handoff: { handoffState: "done", handoffDetail: "keep", ownerPid: null, leaseAt: null },
    },
  });
  expect(client.serialize()).toEqual(before);
});

test("a published continuation can claim its live associating process's hold", () => {
  using client = handoffWriteFixture();
  client.query("UPDATE kind_handoffs SET owner_pid = ?").run(process.ppid);
  expect(claimHandoff(client, "owner/repo", "s1", "build", process.ppid)).toMatchObject({
    tag: "Ok",
    value: { handoff: { handoffState: "pending", ownerPid: process.pid } },
  });
});

test.each(["pending", "done", "foreign"])(
  "publication transfers only its own pending hold, not %s",
  (state) => {
    using client = handoffWriteFixture();
    if (state === "done") client.exec("UPDATE kind_handoffs SET handoff_state = 'done'");
    if (state === "foreign")
      client.query("UPDATE kind_handoffs SET owner_pid = ?").run(process.ppid);
    const before = client.serialize();
    expect(startHandoff(client, "s1", "build", process.ppid).tag).toBe("Ok");
    if (state === "pending")
      expect(client.query("SELECT owner_pid FROM kind_handoffs").get()).toEqual({
        owner_pid: process.ppid,
      });
    else expect(client.serialize()).toEqual(before);
  },
);

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
      detail: "The source does not exist in this project.",
      next: { command: "operator next", why: "Choose an existing source in this project." },
    },
  });
  expect(claimHandoff(client, "owner/repo", "s1", "missing", null)).toMatchObject({
    tag: "Err",
    error: {
      reason: "handoff_not_found",
      detail: "Assignment missing has no recorded kind handoff. Nothing was changed.",
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
      detail: `Process ${process.ppid} is still handing off assignment build. Read operator next later. Nothing was changed.`,
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
