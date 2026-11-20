import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { migrationsFolder } from "./database.ts";
import { insertRow } from "./state-fixture.ts";
import {
  parkPullRequest,
  completeParking,
  claimParkedRead,
  finishParkedRead,
  resumeParkedPullRequest,
  prParkingSchema,
} from "./pr-parking.ts";

test("parking retains legacy facts and accepts unknown heads only with explicit migration origin", () => {
  const park = {
    launchId: "old",
    head: "known",
    at: "then",
    note: "/notes/park.md",
    state: "parked" as const,
    events: [],
  };
  expect(prParkingSchema.parse(park)).toEqual({ ...park, parentSeen: false });
  expect(prParkingSchema.safeParse({ ...park, head: null }).success).toBe(false);
  expect(prParkingSchema.parse({ ...park, head: null, origin: "migration-0026" })).toEqual({
    ...park,
    parentSeen: false,
    head: null,
    origin: "migration-0026",
  });
});

function fixture() {
  const db = new Database(":memory:");
  migrate(drizzle(db), { migrationsFolder });
  insertRow(db, "sources", { id: "s", repository: "owner/repo", state: "open" });
  insertRow(db, "assignments", { source_id: "s", key: "a", completion: "pr", state: "pr-open" });
  insertRow(db, "launches", {
    id: "l",
    source_id: "s",
    assignment: "a",
    attempt: 1,
    state: "running",
    branch: "task/a",
    kind: JSON.stringify(WorkerKinds.resolve("pr-feedback")),
  });
  insertRow(db, "pull_requests", {
    source_id: "s",
    assignment: "a",
    repository: "owner/repo",
    number: 7,
    branch: "task/a",
    progress: '{"seen":[],"failures":[],"eligibleHead":null}',
    readiness: '{"head":"h","at":"now","note":null,"dispositions":[]}',
    wait_state: "waiting",
  });
  return db;
}

test("parking retains the pushed head and park note with the recorded outgoing handoff", () => {
  using db = fixture();
  expect(parkPullRequest(db, "l", { head: "h", note: "/device/park.md" })).toMatchObject({
    tag: "Ok",
  });
  expect(db.query("SELECT state FROM assignments").get()).toEqual({ state: "pr-open" });
  expect(
    db.query("SELECT outgoing_launch_id, next_kind, handoff_state FROM kind_handoffs").get(),
  ).toEqual({ outgoing_launch_id: "l", next_kind: "pr-feedback", handoff_state: "pending" });
  const row = db.query<{ parking: string }, []>("SELECT parking FROM pull_requests").get();
  expect(JSON.parse(row?.parking ?? "null")).toMatchObject({
    launchId: "l",
    head: "h",
    note: "/device/park.md",
    state: "parking",
    events: [],
  });
});

test("one recorded batch schedule and cursor commit survives quiet and repeated waits", () => {
  using db = fixture();
  const now = Date.now();
  expect(claimParkedRead(db, now)).toMatchObject({
    tag: "Ok",
    value: { at: new Date(now).toISOString() },
  });
  expect(claimParkedRead(db, now + 1)).toMatchObject({ tag: "Ok", value: null });
  expect(finishParkedRead(db, new Date(now).toISOString(), [])).toMatchObject({ tag: "Ok" });
  expect(claimParkedRead(db, now + 899999)).toMatchObject({ tag: "Ok", value: null });
  expect(claimParkedRead(db, now + 900000)).toMatchObject({
    tag: "Ok",
    value: { at: new Date(now + 900000).toISOString() },
  });
});

test("a quiet parked PR refuses resume without a recorded event or any handoff write", () => {
  using db = fixture();
  const before = db.serialize();
  expect(
    resumeParkedPullRequest(db, { repository: "owner/repo", sourceId: "s", assignment: "a" }),
  ).toMatchObject({ tag: "Err", error: { reason: "pr_resume_refused" } });
  expect(db.serialize()).toEqual(before);
});

test("a committed waking event survives resume and stale batch commits cannot erase it", () => {
  using db = fixture();
  const target = { repository: "owner/repo", sourceId: "s", assignment: "a" };
  const parked = parkPullRequest(db, "l", { head: "h", note: null });
  expect(parked.tag).toBe("Ok");
  db.exec("UPDATE launches SET state = 'finished'");
  const beforeWrongRepository = db.serialize();
  expect(completeParking(db, { ...target, repository: "foreign/repo" })).toMatchObject({
    tag: "Err",
    error: { reason: "pr_resume_refused" },
  });
  expect(db.serialize()).toEqual(beforeWrongRepository);
  expect(completeParking(db, target)).toMatchObject({ tag: "Ok", value: true });
  const claimed = claimParkedRead(db, Date.now());
  expect(claimed).toMatchObject({ tag: "Ok", value: { rows: [{ assignment: "a" }] } });
  if (claimed.tag !== "Ok" || claimed.value === null) return;
  const row = claimed.value.rows[0];
  expect(row).toBeDefined();
  if (row === undefined) return;
  const update = {
    ...target,
    previous: JSON.stringify(row.parking),
    progress: '{"seen":["C1"],"failures":[],"eligibleHead":null}',
    parking: { ...row.parking, events: ['{"kind":"feedback","id":"C1"}'] },
  };
  expect(finishParkedRead(db, claimed.value.at, [update])).toMatchObject({
    tag: "Ok",
    value: true,
  });
  expect(resumeParkedPullRequest(db, target)).toMatchObject({ tag: "Ok" });
  expect(
    finishParkedRead(db, claimed.value.at, [{ ...update, parking: row.parking }]),
  ).toMatchObject({ tag: "Ok", value: false });
  expect(
    JSON.parse(
      db.query<{ parking: string }, []>("SELECT parking FROM pull_requests").get()?.parking ??
        "null",
    ),
  ).toMatchObject({ state: "resuming", events: ['{"kind":"feedback","id":"C1"}'] });
  const before = db.serialize();
  expect(resumeParkedPullRequest(db, target)).toMatchObject({ tag: "Err" });
  expect(db.serialize()).toEqual(before);
});

test("a raced batch receipt refuses the whole cursor commit without acknowledging the read", () => {
  using db = fixture();
  const target = { repository: "owner/repo", sourceId: "s", assignment: "a" };
  expect(parkPullRequest(db, "l", { head: "h", note: null }).tag).toBe("Ok");
  db.exec("UPDATE launches SET state = 'finished'");
  expect(completeParking(db, target)).toMatchObject({ tag: "Ok", value: true });
  const claim = claimParkedRead(db, Date.now()).getOr(null);
  const row = claim?.rows[0] ?? expect.unreachable("Missing batch row");
  db.query("UPDATE pull_requests SET parking = ?").run(
    JSON.stringify({ ...row.parking, events: ["racing event"] }),
  );
  expect(
    finishParkedRead(db, claim?.at ?? "", [
      {
        ...target,
        previous: JSON.stringify(row.parking),
        progress: "new cursor",
        parking: row.parking,
      },
    ]),
  ).toMatchObject({ tag: "Ok", value: false });
  expect(db.query("SELECT last_read_at FROM parked_pr_reads").get()).toEqual({
    last_read_at: null,
  });
  expect(db.query("SELECT progress FROM pull_requests").get()).toEqual({
    progress: '{"seen":[],"failures":[],"eligibleHead":null}',
  });
});

test.each([
  "UPDATE sources SET state = 'reset'",
  "UPDATE assignments SET state = 'merged'",
  "UPDATE launches SET state = 'running'",
  "UPDATE launches SET id = 'replacement'",
  "UPDATE kind_handoffs SET owner_pid = 99999999",
  "UPDATE kind_handoffs SET outgoing_launch_id = 'replacement'",
])("parking completion rechecks its transaction fence: %s", (race) => {
  using db = fixture();
  expect(parkPullRequest(db, "l", { head: "h", note: null }).tag).toBe("Ok");
  db.exec("UPDATE launches SET state = 'finished'");
  db.exec(race);
  const before = db.serialize();
  expect(
    completeParking(db, { repository: "owner/repo", sourceId: "s", assignment: "a" }),
  ).toMatchObject({ tag: "Err", error: { reason: "pr_resume_refused" } });
  expect(db.serialize()).toEqual(before);
});
