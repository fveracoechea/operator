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
  readDelivery,
  recordDeliveryRequest,
  suspendDelivery,
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

test("request identity and original audit survive suspension and read-only recovery", () => {
  using db = fixture();
  expect(readDelivery(db, "l1")).toMatchObject({ tag: "Ok", value: null });
  expect(readDelivery(db, "missing")).toMatchObject({ tag: "Ok", value: null });
  const original = claimDelivery(db, request);
  expect(original.tag).toBe("Ok");
  expect(recordDeliveryRequest(db, "other", "wrong").tag).toBe("Ok");
  expect(readDelivery(db, "l1")).toMatchObject({ tag: "Ok", value: { requestUuid: null } });
  expect(recordDeliveryRequest(db, "l1", "u1").tag).toBe("Ok");
  expect<unknown>(claimDelivery(db, { ...request, reconcile: true })).toMatchObject({
    tag: "Err",
    error: { reason: "pr_delivery_running" },
  });
  expect(suspendDelivery(db, "other").tag).toBe("Ok");
  expect(readDelivery(db, "l1")).toMatchObject({ tag: "Ok", value: { ownerPid: process.pid } });
  expect(suspendDelivery(db, "l1").tag).toBe("Ok");
  expect(recordDeliveryRequest(db, "l1", "must-not-overwrite").tag).toBe("Ok");
  expect(readDelivery(db, "l1")).toMatchObject({
    tag: "Ok",
    value: { requestUuid: "u1", ownerPid: null, endedAt: null },
  });
  expect<unknown>(
    claimDelivery(db, {
      ...request,
      head: "different",
      resumeId: original.tag === "Ok" ? original.value.id : "",
      selected: false,
      session: "another",
      reconcile: true,
    }),
  ).toMatchObject({
    tag: "Ok",
    value: { head: "h1", session: "supervisor", selected: true, requestUuid: "u1" },
  });
  expect(finishDelivery(db, "l1", "h1").tag).toBe("Ok");
  expect(readDelivery(db, "l1")).toMatchObject({ tag: "Ok", value: null });
  expect(db.query("SELECT COUNT(*) AS count FROM deliveries").get()).toEqual({ count: 1 });
});

test("an unfinished delivery survives its process and cannot silently become a new mutation", () => {
  using db = fixture();
  expect(claimDelivery(db, request).tag).toBe("Ok");
  db.exec("UPDATE deliveries SET owner_pid = NULL, lease_at = NULL");
  expect<unknown>(claimDelivery(db, request)).toMatchObject({
    tag: "Err",
    error: { reason: "pr_delivery_running" },
  });
  expect(db.query("SELECT ended_at, session, head FROM deliveries").all()).toEqual([
    { ended_at: null, session: "supervisor", head: "h1" },
  ]);
});

test("a reconciliation cannot acquire a different request or create a claim after its observed request ended", () => {
  using db = fixture();
  expect(claimDelivery(db, request).tag).toBe("Ok");
  expect(suspendDelivery(db, "l1").tag).toBe("Ok");
  const resume = { ...request, reconcile: true, resumeId: "a-different-request" };
  for (const pending of [true, false]) {
    if (!pending) db.exec("UPDATE deliveries SET ended_at = 'done'");
    failure(
      claimDelivery(db, resume),
      "pr_delivery_running",
      "The outstanding delivery changed during reconciliation. Read its current outcome before retrying.",
    );
  }
  expect(db.query("SELECT COUNT(*) AS count FROM deliveries").get()).toEqual({ count: 1 });
});

test("replacing a launch cannot discard its assignment's outstanding delivery", () => {
  using db = fixture();
  insertRow(db, "launches", {
    id: "older",
    source_id: "s1",
    assignment: "a",
    state: "stopped",
    attempt: 0,
  });
  insertRow(db, "deliveries", {
    id: "d0",
    launch_id: "older",
    head: "original",
    selected: 1,
    started_at: "then",
  });
  expect<unknown>(claimDelivery(db, request)).toMatchObject({
    tag: "Err",
    error: { reason: "pr_delivery_running" },
  });
  expect<unknown>(readDelivery(db, "l1")).toMatchObject({
    tag: "Ok",
    value: { launchId: "older", head: "original" },
  });
  expect<unknown>(claimDelivery(db, { ...request, reconcile: true })).toMatchObject({
    tag: "Ok",
    value: { launchId: "older", head: "original" },
  });
  expect(db.query("SELECT head, ended_at FROM deliveries").all()).toEqual([
    { head: "original", ended_at: null },
  ]);
});

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
    value: { readyHead: "h1" },
  });
  expect(finishDelivery(db, "l1", "h1").tag).toBe("Ok");
  for (const state of ["ready", "skipped"]) {
    db.query("UPDATE internal_reviews SET state = ?").run(state);
    expect(claimDelivery(db, request)).toMatchObject({ tag: "Ok", value: { readyHead: "h1" } });
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
    readyHead: "reviewed",
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
    "An earlier delivery remains unfinished. Reconcile its remote outcome before another delivery.",
  );
  expect(finishDelivery(db, "l1", "wrong-head").tag).toBe("Ok");
  failure(
    claimDelivery(db, request),
    "pr_delivery_running",
    "An earlier delivery remains unfinished. Reconcile its remote outcome before another delivery.",
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
  expect(readDelivery(copy.subject, "l1")).toMatchObject({ tag: "Ok", value: null });
  expect(claimDelivery(copy.subject, { ...request, session: "stranger" })).toMatchObject(busy);
  expect(
    recordDeliveryValidation(copy.subject, {
      launchId: "l1",
      head: "h1",
      readyHead: "old",
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
        "SELECT head, ready_head, session, selected, owner_pid, lease_at, ended_at IS NOT NULL AS ended FROM deliveries",
      )
      .get(),
  ).toEqual({
    head: "h1",
    ready_head: null,
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

test("changed heads need bounded-correction validation without replacing the ready head", () => {
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
    "This head has no bounded-correction validation tied to the ready head. The owner must run operator pr validate --file <evidence.txt> --json.",
  );
  expect<unknown>(
    recordDeliveryValidation(db, {
      launchId: "l1",
      head: "h1",
      readyHead: "reviewed",
      summary: "Bounded correction passed CI.",
    }),
  ).toMatchObject({ tag: "Ok" });
  expect<unknown>(claimDelivery(db, request)).toMatchObject({
    tag: "Ok",
    value: { head: "h1", readyHead: "reviewed" },
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
