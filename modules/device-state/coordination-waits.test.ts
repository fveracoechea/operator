import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { migrationsFolder } from "./database.ts";
import { registerProject, removeProject } from "./projects.ts";
import { deleteSourceRecords, registerSource } from "./sources.ts";
import {
  finishCoordinationWait,
  readSupervision,
  readSupervisor,
  renewCoordinationWait,
  startCoordinationWait,
  takeOverSource,
} from "./coordination-waits.ts";
import { busy, reservedCopy } from "./state-fixture.ts";

const all = { repository: "owner/one", scope: "" };
const one = { repository: "owner/one", scope: "s1" };
const nobody = { pane: null, session: null };

/** A pane's agent session is named after the pane. */
function by(pane: string) {
  return { pane, session: `ses-${pane}` };
}

function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(drizzle(db), { migrationsFolder });
  registerProject(db, { repository: "owner/one", checkout: "/one", registeredAt: "now" });
  return db;
}

function rows(db: Database) {
  return db
    .query<
      {
        scope: string;
        actions: string | null;
        owner_pid: number | null;
        lease_at: string | null;
        pane_id: string | null;
        session: string | null;
        returned_at: string | null;
      },
      []
    >(
      "SELECT scope, actions, owner_pid, lease_at, pane_id, session, returned_at FROM coordination_waits ORDER BY scope",
    )
    .all();
}

test("a first wait records its process, pane, and session, and has no returned set", () => {
  using db = fixture();
  expect(startCoordinationWait(db, all, by("pane-1"))).toMatchObject({ tag: "Ok", value: null });
  expect(rows(db)).toEqual([
    {
      scope: "",
      actions: null,
      owner_pid: process.pid,
      lease_at: expect.any(String) as string,
      pane_id: "pane-1",
      session: "ses-pane-1",
      returned_at: null,
    },
  ]);
});

test("a finished wait records its set and ends, and the next wait of the scope reads that set", () => {
  using db = fixture();
  startCoordinationWait(db, all, by("pane-1"));
  expect(finishCoordinationWait(db, all, '["a"]')).toMatchObject({ tag: "Ok", value: undefined });
  expect(rows(db)).toEqual([
    {
      scope: "",
      actions: '["a"]',
      owner_pid: null,
      lease_at: null,
      pane_id: "pane-1",
      session: "ses-pane-1",
      returned_at: expect.any(String) as string,
    },
  ]);
  // Each scope keeps its own set.
  source(db, "s1");
  expect(startCoordinationWait(db, one, nobody)).toMatchObject({ tag: "Ok", value: null });
  expect(startCoordinationWait(db, all, by("pane-2"))).toMatchObject({ tag: "Ok", value: '["a"]' });
  expect(rows(db).map((row) => [row.scope, row.owner_pid, row.pane_id])).toEqual([
    ["", process.pid, "pane-2"],
    ["s1", process.pid, null],
  ]);
});

test("a wait that a later process replaced records its set but leaves the later wait running", () => {
  using db = fixture();
  startCoordinationWait(db, all, by("pane-1"));
  db.query("UPDATE coordination_waits SET owner_pid = ?, lease_at = 'later'").run(process.pid + 1);
  finishCoordinationWait(db, all, "[]");
  renewCoordinationWait(db, all);
  expect(rows(db)).toMatchObject([
    { actions: "[]", owner_pid: process.pid + 1, lease_at: "later" },
  ]);
});

test("a renewal moves only this process's lease", () => {
  using db = fixture();
  startCoordinationWait(db, all, nobody);
  db.query("UPDATE coordination_waits SET lease_at = 'old'").run();
  expect(renewCoordinationWait(db, all)).toMatchObject({ tag: "Ok", value: undefined });
  expect(rows(db)[0]?.lease_at).not.toBe("old");
});

function source(db: Database, id: string, state = "open", repository = "owner/one") {
  registerSource(
    db,
    repository === "owner/one" ? "/one" : "/two",
    {
      id,
      repository,
      trackerKey: `APP-${id}`,
      state,
      registeredAt: "now",
      endedAt: null,
      plan: "{}",
    },
    [],
  );
}

function supervisors(db: Database) {
  return db
    .query<{ id: string; supervising_pane: string | null; supervising_session: string | null }, []>(
      "SELECT id, supervising_pane, supervising_session FROM sources ORDER BY id",
    )
    .all()
    .map((row) => [row.id, row.supervising_pane, row.supervising_session]);
}

test("a wait without a source claims only the open sources of its project that nobody supervises", () => {
  using db = fixture();
  registerProject(db, { repository: "owner/two", checkout: "/two", registeredAt: "now" });
  source(db, "s1");
  source(db, "s2");
  source(db, "s3", "finished");
  source(db, "s4", "open", "owner/two");
  source(db, "s5");
  db.query("UPDATE sources SET supervising_pane = 'other' WHERE id = 's2'").run();
  db.query("UPDATE sources SET supervising_session = 'ses-other' WHERE id = 's5'").run();
  startCoordinationWait(db, all, by("pane-1"));
  expect(supervisors(db)).toEqual([
    ["s1", "pane-1", "ses-pane-1"],
    ["s2", "other", null],
    ["s3", null, null],
    ["s4", null, null],
    ["s5", null, "ses-other"],
  ]);
  // A wait with neither a pane nor a session claims nothing.
  startCoordinationWait(db, all, nobody);
  expect(supervisors(db)[0]).toEqual(["s1", "pane-1", "ses-pane-1"]);
  // A session outside Herdr claims with its session alone.
  source(db, "s6");
  startCoordinationWait(db, all, { pane: null, session: "ses-cli" });
  expect(supervisors(db)[5]).toEqual(["s6", null, "ses-cli"]);
});

test("a wait for one source records its pane and session as that source's supervisor", () => {
  using db = fixture();
  source(db, "s1");
  source(db, "s2");
  db.query("UPDATE sources SET supervising_pane = 'other'").run();
  startCoordinationWait(db, one, by("pane-1"));
  expect(supervisors(db)).toEqual([
    ["s1", "pane-1", "ses-pane-1"],
    ["s2", "other", null],
  ]);
  startCoordinationWait(db, one, nobody);
  expect(supervisors(db)[0]).toEqual(["s1", "pane-1", "ses-pane-1"]);
  // Another project's wait cannot claim the source.
  registerProject(db, { repository: "owner/two", checkout: "/two", registeredAt: "now" });
  startCoordinationWait(db, { repository: "owner/two", scope: "s1" }, by("pane-2"));
  expect(supervisors(db)[0]).toEqual(["s1", "pane-1", "ses-pane-1"]);
});

test("the supervisor of a source names its pane and session, and a take-over replaces both", () => {
  using db = fixture();
  source(db, "s1");
  expect(readSupervisor(db, "owner/one", "s1")).toMatchObject({
    tag: "Ok",
    value: { pane: null, session: null },
  });
  startCoordinationWait(db, one, by("pane-1"));
  expect(readSupervisor(db, "owner/one", "s1")).toMatchObject({
    tag: "Ok",
    value: { pane: "pane-1", session: "ses-pane-1" },
  });
  expect(takeOverSource(db, "owner/one", "s1", by("pane-2"))).toMatchObject({
    tag: "Ok",
    value: { pane: "pane-1", session: "ses-pane-1" },
  });
  expect(supervisors(db)).toEqual([["s1", "pane-2", "ses-pane-2"]]);
  // A take-over without a session leaves the source to the next wait or dispatch.
  takeOverSource(db, "owner/one", "s1", nobody);
  expect(supervisors(db)).toEqual([["s1", null, null]]);
  startCoordinationWait(db, all, by("pane-3"));
  expect(supervisors(db)).toEqual([["s1", "pane-3", "ses-pane-3"]]);
  registerProject(db, { repository: "owner/two", checkout: "/two", registeredAt: "now" });
  for (const result of [
    readSupervisor(db, "owner/two", "s1"),
    takeOverSource(db, "owner/two", "s1", by("pane-2")),
  ])
    expect(result).toMatchObject({ tag: "Err", error: { reason: "source_not_found" } });
  expect(supervisors(db)).toEqual([["s1", "pane-3", "ses-pane-3"]]);
});

test("a wait for a source that the project does not have refuses and records nothing", () => {
  using db = fixture();
  registerProject(db, { repository: "owner/two", checkout: "/two", registeredAt: "now" });
  source(db, "s1", "open", "owner/two");
  for (const target of [one, { repository: "owner/one", scope: "missing" }])
    expect(startCoordinationWait(db, target, by("pane-1"))).toMatchObject({
      tag: "Err",
      error: { reason: "source_not_found" },
    });
  expect(rows(db)).toEqual([]);
  expect(supervisors(db)).toEqual([["s1", null, null]]);
});

test("deleted sources and a removed project delete their coordination waits", () => {
  using db = fixture();
  source(db, "s1");
  startCoordinationWait(db, all, nobody);
  startCoordinationWait(db, one, nobody);
  deleteSourceRecords(drizzle(db), ["s1"]);
  expect(rows(db).map((row) => row.scope)).toEqual([""]);
  expect(removeProject(db, "owner/one").tag).toBe("Ok");
  expect(rows(db)).toEqual([]);
});

test("each write waits for the writer reservation", () => {
  using db = fixture();
  using reserved = reservedCopy(db);
  expect(startCoordinationWait(reserved.subject, all, nobody)).toMatchObject(busy);
  expect(finishCoordinationWait(reserved.subject, all, "[]")).toMatchObject(busy);
  expect(renewCoordinationWait(reserved.subject, all)).toMatchObject(busy);
  expect(takeOverSource(reserved.subject, "owner/one", "s1", nobody)).toMatchObject(busy);
});

test("supervision lists the session's sources and whether a running wait from that session covers each", () => {
  using db = fixture();
  registerProject(db, {
    repository: "owner/two",
    checkout: "/two",
    registeredAt: "now",
  });
  source(db, "s1");
  source(db, "s2");
  source(db, "s3", "finished");
  source(db, "s4", "open", "owner/two");
  db.query("UPDATE sources SET supervising_session = 'ses-pane-1' WHERE id != 's2'").run();
  // The pane alone supervises nothing: a new session in the same pane is not the supervisor.
  db.query(
    "UPDATE sources SET supervising_pane = 'pane-1', supervising_session = 'ses-other' WHERE id = 's2'",
  ).run();
  expect(readSupervision(db, "ses-pane-1")).toMatchObject({
    tag: "Ok",
    value: [
      { id: "s1", repository: "owner/one", waiting: false },
      { id: "s3", repository: "owner/one", waiting: false },
      { id: "s4", repository: "owner/two", waiting: false },
    ],
  });
  // A wait for one source covers only that source, and a project wait covers its project.
  startCoordinationWait(db, one, by("pane-1"));
  expect(readSupervision(db, "ses-pane-1")).toMatchObject({
    value: [{ waiting: true }, { waiting: false }, { waiting: false }],
  });
  startCoordinationWait(db, { repository: "owner/two", scope: "" }, by("pane-1"));
  expect(readSupervision(db, "ses-pane-1")).toMatchObject({
    value: [{ waiting: true }, { waiting: false }, { waiting: true }],
  });
});

test("a finished wait, a gone process, or a wait from another session covers nothing", () => {
  using db = fixture();
  source(db, "s1");
  db.query("UPDATE sources SET supervising_session = 'ses-pane-1'").run();
  startCoordinationWait(db, all, { pane: "pane-1", session: "ses-new" });
  expect(readSupervision(db, "ses-pane-1")).toMatchObject({
    value: [{ id: "s1", waiting: false }],
  });
  startCoordinationWait(db, all, by("pane-1"));
  expect(readSupervision(db, "ses-pane-1")).toMatchObject({ value: [{ waiting: true }] });
  finishCoordinationWait(db, all, "[]");
  expect(readSupervision(db, "ses-pane-1")).toMatchObject({ value: [{ waiting: false }] });
  startCoordinationWait(db, all, by("pane-1"));
  db.query("UPDATE coordination_waits SET lease_at = '2000-01-01T00:00:00.000Z'").run();
  expect(readSupervision(db, "ses-pane-1")).toMatchObject({ value: [{ waiting: false }] });
  // A session that supervises nothing has no sources.
  expect(readSupervision(db, "ses-new")).toMatchObject({ tag: "Ok", value: [] });
});
