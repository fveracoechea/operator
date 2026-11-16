import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { migrationsFolder } from "./database.ts";
import { insertRow, reservedCopy, busy } from "./state-fixture.ts";
import { recordPullRequestWait } from "./pull-requests.ts";
import { changeObligation } from "./obligations.ts";
import { Ok } from "unthrown";
import {
  claimDelivery,
  finishDelivery,
  recordDeliveryValidation,
  renewDelivery,
} from "./deliveries.ts";

function fixture() {
  const db = new Database(":memory:");
  migrate(drizzle(db), { migrationsFolder });
  insertRow(db, "projects", { repository: "owner/one", checkout: "/one" });
  insertRow(db, "sources", {
    id: "s1",
    repository: "owner/one",
    state: "open",
    supervising_session: "supervisor",
  });
  insertRow(db, "assignments", { source_id: "s1", key: "a", completion: "pr", state: "pr-open" });
  insertRow(db, "launches", {
    id: "l1",
    source_id: "s1",
    assignment: "a",
    state: "running",
    attempt: 1,
    branch: "task/a",
    activity: "idle",
  });
  insertRow(db, "pull_requests", {
    source_id: "s1",
    assignment: "a",
    repository: "owner/one",
    number: 7,
    branch: "task/a",
    wait_state: "idle",
  });
  return db;
}

const request = { launchId: "l1", head: "h1", session: "supervisor", selected: true };

type DeliveryAnswer =
  | ReturnType<typeof claimDelivery>
  | ReturnType<typeof recordDeliveryValidation>;
function failure(result: DeliveryAnswer, reason: string, detail: string) {
  expect(result).toMatchObject({
    tag: "Err",
    error: {
      reason,
      detail: `${detail} Nothing was merged or removed.`,
      next: { decider: "super-agent", question: expect.stringMatching(/\S/) as unknown },
    },
  });
}

test("authority, branch ownership, and active work are checked again inside the claim", () => {
  using db = fixture();
  for (const session of ["stranger", null])
    failure(
      claimDelivery(db, { ...request, session }),
      "source_supervised_elsewhere",
      "Only this source's recorded supervising session may select delivery.",
    );
  db.exec("UPDATE sources SET supervising_session = NULL");
  failure(
    claimDelivery(db, { ...request, session: null }),
    "source_supervised_elsewhere",
    "Only this source's recorded supervising session may select delivery.",
  );
  db.exec(
    "UPDATE sources SET supervising_session = 'supervisor'; UPDATE launches SET activity = 'working'",
  );
  failure(
    claimDelivery(db, request),
    "pr_owner_busy",
    "The PR owner is not recorded idle. Ask the owner to finish its active work first.",
  );
  expect(claimDelivery(db, { ...request, selected: false }).tag).toBe("Ok");
  expect(finishDelivery(db, "l1", "h1").tag).toBe("Ok");
  db.exec(
    "UPDATE launches SET activity = 'idle'; UPDATE pull_requests SET branch = 'another-branch'",
  );
  failure(
    claimDelivery(db, request),
    "pr_not_associated",
    "The launch does not own this PR branch.",
  );
  db.exec("DELETE FROM pull_requests");
  failure(
    claimDelivery(db, request),
    "pr_not_associated",
    "The launch does not own this PR branch.",
  );
});

test("ended review state and ready-head provenance remain mandatory", () => {
  using db = fixture();
  insertRow(db, "internal_reviews", {
    source_id: "s1",
    assignment: "a",
    state: "reviewing",
    ready_head: "h1",
    implementer_launch_id: "implementer",
  });
  failure(claimDelivery(db, request), "pr_merge_blocked", "The internal review has not ended.");
  expect(claimDelivery(db, { ...request, reconcile: true })).toMatchObject({
    tag: "Ok",
    value: { reviewedHead: "h1" },
  });
  expect(finishDelivery(db, "l1", "h1").tag).toBe("Ok");
  for (const state of ["ready", "skipped"]) {
    db.query("UPDATE internal_reviews SET state = ?").run(state);
    expect(claimDelivery(db, request)).toMatchObject({ tag: "Ok", value: { reviewedHead: "h1" } });
    expect(finishDelivery(db, "l1", "h1").tag).toBe("Ok");
  }
  db.exec("UPDATE internal_reviews SET ready_head = NULL");
  failure(
    claimDelivery(db, request),
    "pr_validation_stale",
    "The ended review has no recorded ready head. Reconcile its provenance before delivery.",
  );
});

test("a stale correction cannot rewrite an absent, active, or different reviewed head", () => {
  using db = fixture();
  const input = {
    launchId: "l1",
    head: "h1",
    reviewedHead: "reviewed",
    summary: "Correction evidence",
  };
  const detail =
    "The recorded review provenance changed. Read the assignment before validating again.";
  failure(recordDeliveryValidation(db, input), "pr_validation_stale", detail);
  insertRow(db, "internal_reviews", {
    source_id: "s1",
    assignment: "a",
    state: "reviewing",
    ready_head: "reviewed",
    implementer_launch_id: "implementer",
  });
  failure(recordDeliveryValidation(db, input), "pr_validation_stale", detail);
  db.exec("UPDATE internal_reviews SET state = 'ready', ready_head = 'different'");
  failure(recordDeliveryValidation(db, input), "pr_validation_stale", detail);
  db.exec("UPDATE internal_reviews SET state = 'skipped', ready_head = 'reviewed'");
  expect(recordDeliveryValidation(db, input)).toMatchObject({ tag: "Ok", value: input });
});

test("expired wait and relay claims do not block delivery, while a live claim does", () => {
  using db = fixture();
  const now = new Date().toISOString();
  db.query("UPDATE pull_requests SET wait_owner_pid = ?, wait_lease_at = ?, relay = ?").run(
    process.pid,
    "2000-01-01T00:00:00.000Z",
    JSON.stringify({ ownerPid: process.pid, leaseAt: "2000-01-01T00:00:00.000Z" }),
  );
  expect(claimDelivery(db, request).tag).toBe("Ok");
  failure(
    claimDelivery(db, request),
    "pr_delivery_running",
    "Another process delivers this assignment. Wait for its result.",
  );
  expect(finishDelivery(db, "l1", "wrong-head").tag).toBe("Ok");
  failure(
    claimDelivery(db, request),
    "pr_delivery_running",
    "Another process delivers this assignment. Wait for its result.",
  );
  expect(finishDelivery(db, "l1", "h1").tag).toBe("Ok");
  db.query("UPDATE pull_requests SET wait_lease_at = ?").run(now);
  failure(
    claimDelivery(db, request),
    "pr_owner_busy",
    "A PR wait is active. Stop that job before delivery.",
  );
  db.query("UPDATE pull_requests SET wait_owner_pid = NULL, relay = ?").run(
    JSON.stringify({ ownerPid: process.pid, leaseAt: now }),
  );
  failure(
    claimDelivery(db, request),
    "pr_owner_busy",
    "A parent relay holds this branch. Wait for it to finish before delivery.",
  );
});

test("claim and correction validation reserve the writer before any refusal", () => {
  using db = fixture();
  using copy = reservedCopy(db);
  expect(claimDelivery(copy.subject, { ...request, session: "stranger" })).toMatchObject(busy);
  expect(
    recordDeliveryValidation(copy.subject, {
      launchId: "l1",
      head: "h1",
      reviewedHead: "old",
      summary: "Evidence",
    }),
  ).toMatchObject(busy);
});

test("renewal refreshes only this process's live claim and retains the audit after release", () => {
  using db = fixture();
  expect(claimDelivery(db, request).tag).toBe("Ok");
  db.exec("UPDATE deliveries SET lease_at = '2000'");
  expect(renewDelivery(db, "other").tag).toBe("Ok");
  expect(db.query("SELECT lease_at FROM deliveries").get()).toEqual({ lease_at: "2000" });
  expect(renewDelivery(db, "l1").tag).toBe("Ok");
  expect(db.query("SELECT lease_at > '2001' AS fresh FROM deliveries").get()).toEqual({ fresh: 1 });
  expect(finishDelivery(db, "l1", "h1").tag).toBe("Ok");
  expect(
    db
      .query(
        "SELECT head, reviewed_head, session, selected, owner_pid, lease_at, ended_at IS NOT NULL AS ended FROM deliveries",
      )
      .get(),
  ).toEqual({
    head: "h1",
    reviewed_head: null,
    session: "supervisor",
    selected: 1,
    owner_pid: null,
    lease_at: null,
    ended: 1,
  });
});

test("a source merge hold refuses both owner and supervisor delivery", () => {
  using db = fixture();
  insertRow(db, "obligations", { source_id: "s1", key: "hold", kind: "merge-hold", state: "open" });
  for (const selected of [false, true])
    failure(
      claimDelivery(db, { ...request, selected }),
      "pr_merge_held",
      "The person's merge hold hold remains open. Wait for the person to release it.",
    );
  expect(db.query("SELECT * FROM deliveries").all()).toEqual([]);
});

test("one delivery claim serializes owner and supervisor and retains its audited head", () => {
  using db = fixture();
  expect<unknown>(claimDelivery(db, request)).toMatchObject({
    tag: "Ok",
    value: { head: "h1", session: "supervisor" },
  });
  expect<unknown>(claimDelivery(db, { ...request, selected: false })).toMatchObject({
    tag: "Err",
    error: { reason: "pr_delivery_running" },
  });
  expect<unknown>(
    recordPullRequestWait(db, "l1", () => ({ progress: "{}", waitState: "waiting" })),
  ).toMatchObject({ tag: "Err", error: { reason: "pr_delivery_running" } });
  expect<unknown>(finishDelivery(db, "l1", "h1")).toMatchObject({ tag: "Ok" });
  expect<unknown>(claimDelivery(db, { ...request, selected: false })).toMatchObject({ tag: "Ok" });
});

test("changed heads need bounded-correction validation without replacing the reviewed head", () => {
  using db = fixture();
  insertRow(db, "internal_reviews", {
    source_id: "s1",
    assignment: "a",
    state: "ready",
    ready_head: "reviewed",
    implementer_launch_id: "implementer",
  });
  failure(
    claimDelivery(db, request),
    "pr_validation_stale",
    "This head has no bounded-correction validation tied to the reviewed head. The owner must run operator pr validate --file <evidence.txt> --json.",
  );
  expect<unknown>(
    recordDeliveryValidation(db, {
      launchId: "l1",
      head: "h1",
      reviewedHead: "reviewed",
      summary: "Bounded correction passed CI.",
    }),
  ).toMatchObject({ tag: "Ok" });
  expect<unknown>(claimDelivery(db, request)).toMatchObject({
    tag: "Ok",
    value: { head: "h1", reviewedHead: "reviewed" },
  });
  expect(db.query("SELECT ready_head FROM internal_reviews").get()).toEqual({
    ready_head: "reviewed",
  });
  expect<unknown>(finishDelivery(db, "l1", "h1")).toMatchObject({ tag: "Ok" });
  expect<unknown>(claimDelivery(db, { ...request, head: "h2" })).toMatchObject({
    tag: "Err",
    error: { reason: "pr_validation_stale" },
  });
});

test("supervisor delivery refuses an active owner wait and a held relay", () => {
  using db = fixture();
  db.query("UPDATE pull_requests SET wait_owner_pid = ?, wait_lease_at = ?").run(
    process.pid,
    new Date().toISOString(),
  );
  expect<unknown>(claimDelivery(db, request)).toMatchObject({
    tag: "Err",
    error: { reason: "pr_owner_busy" },
  });
  db.query("UPDATE pull_requests SET wait_owner_pid = NULL, wait_lease_at = NULL, relay = ?").run(
    JSON.stringify({ ownerPid: process.pid, leaseAt: new Date().toISOString() }),
  );
  expect<unknown>(claimDelivery(db, request)).toMatchObject({
    tag: "Err",
    error: { reason: "pr_owner_busy" },
  });
  expect(db.query("SELECT * FROM deliveries").all()).toEqual([]);
});

test("a hold cannot be acknowledged while an earlier delivery is already in flight", () => {
  using db = fixture();
  expect(claimDelivery(db, request).tag).toBe("Ok");
  expect<unknown>(
    changeObligation(
      db,
      { repository: "owner/one", checkout: "/one", sourceId: "s1" },
      "late-hold",
      () =>
        Ok({
          insert: {
            sourceId: "s1",
            key: "late-hold",
            kind: "merge-hold",
            summary: "Hold this merge",
            reference: null,
            state: "open",
            openedAt: "now",
            closedAt: null,
          },
        }),
    ),
  ).toMatchObject({ tag: "Err", error: { reason: "pr_delivery_running" } });
  expect(db.query("SELECT * FROM obligations").all()).toEqual([]);
});
