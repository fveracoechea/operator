import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { migrationsFolder } from "./database.ts";
import { registerProject, removeProject } from "./projects.ts";
import { deleteSourceRecords, registerSource } from "./sources.ts";
import {
  acknowledgeCoordinationWaits,
  changeCoordinationWait,
  coordinationPaneScope,
  finishCoordinationWait,
  readCoordinationWait,
  readSupervision,
  renewCoordinationWait,
  startCoordinationWait,
} from "./coordination-waits.ts";
import { busy, reservedCopy } from "./state-fixture.ts";

const all = { repository: "owner/one", scope: "" };
const one = { repository: "owner/one", scope: "s1" };

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
        returned_at: string | null;
      },
      []
    >(
      "SELECT scope, actions, owner_pid, lease_at, pane_id, returned_at FROM coordination_waits ORDER BY scope",
    )
    .all();
}

test("a first wait records its process and pane and has no returned set", () => {
  using db = fixture();
  expect(startCoordinationWait(db, all, "pane-1")).toMatchObject({ tag: "Ok", value: null });
  expect(rows(db)).toEqual([
    {
      scope: "",
      actions: null,
      owner_pid: process.pid,
      lease_at: expect.any(String) as string,
      pane_id: "pane-1",
      returned_at: null,
    },
  ]);
});

test("a finished wait records its set and ends, and the next wait of the scope reads that set", () => {
  using db = fixture();
  startCoordinationWait(db, all, "pane-1");
  expect(finishCoordinationWait(db, all, () => '["a"]')).toMatchObject({
    tag: "Ok",
    value: undefined,
  });
  expect(rows(db)).toEqual([
    {
      scope: "",
      actions: '["a"]',
      owner_pid: null,
      lease_at: null,
      pane_id: "pane-1",
      returned_at: expect.any(String) as string,
    },
  ]);
  // Each scope keeps its own set.
  source(db, "s1");
  expect(startCoordinationWait(db, one, null)).toMatchObject({ tag: "Ok", value: null });
  expect(startCoordinationWait(db, all, "pane-2")).toMatchObject({ tag: "Ok", value: '["a"]' });
  expect(rows(db).map((row) => [row.scope, row.owner_pid, row.pane_id])).toEqual([
    ["", process.pid, "pane-2"],
    ["s1", process.pid, null],
  ]);
});

test("a wait that a later process replaced records its set but leaves the later wait running", () => {
  using db = fixture();
  startCoordinationWait(db, all, "pane-1");
  db.query("UPDATE coordination_waits SET owner_pid = ?, lease_at = 'later'").run(process.pid + 1);
  finishCoordinationWait(db, all, () => "[]");
  renewCoordinationWait(db, all);
  expect(rows(db)).toMatchObject([
    { actions: "[]", owner_pid: process.pid + 1, lease_at: "later" },
  ]);
});

test("a renewal moves only this process's lease", () => {
  using db = fixture();
  startCoordinationWait(db, all, null);
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

function panes(db: Database) {
  return db
    .query<{ id: string; supervising_pane: string | null }, []>(
      "SELECT id, supervising_pane FROM sources ORDER BY id",
    )
    .all()
    .map((row) => [row.id, row.supervising_pane]);
}

test("a wait without a source claims only the open sources of its project that no pane supervises", () => {
  using db = fixture();
  registerProject(db, { repository: "owner/two", checkout: "/two", registeredAt: "now" });
  source(db, "s1");
  source(db, "s2");
  source(db, "s3", "finished");
  source(db, "s4", "open", "owner/two");
  db.query("UPDATE sources SET supervising_pane = 'other' WHERE id = 's2'").run();
  startCoordinationWait(db, all, "pane-1");
  expect(panes(db)).toEqual([
    ["s1", "pane-1"],
    ["s2", "other"],
    ["s3", null],
    ["s4", null],
  ]);
  // A wait without a pane claims nothing.
  startCoordinationWait(db, all, null);
  expect(panes(db)[0]).toEqual(["s1", "pane-1"]);
});

test("a wait for one source makes its pane that source's supervising pane", () => {
  using db = fixture();
  source(db, "s1");
  source(db, "s2");
  db.query("UPDATE sources SET supervising_pane = 'other'").run();
  startCoordinationWait(db, one, "pane-1");
  expect(panes(db)).toEqual([
    ["s1", "pane-1"],
    ["s2", "other"],
  ]);
  startCoordinationWait(db, one, null);
  expect(panes(db)[0]).toEqual(["s1", "pane-1"]);
  // Another project's wait cannot claim the source.
  registerProject(db, { repository: "owner/two", checkout: "/two", registeredAt: "now" });
  startCoordinationWait(db, { repository: "owner/two", scope: "s1" }, "pane-2");
  expect(panes(db)[0]).toEqual(["s1", "pane-1"]);
});

test("a wait for a source that the project does not have refuses and records nothing", () => {
  using db = fixture();
  registerProject(db, { repository: "owner/two", checkout: "/two", registeredAt: "now" });
  source(db, "s1", "open", "owner/two");
  for (const target of [one, { repository: "owner/one", scope: "missing" }])
    expect(startCoordinationWait(db, target, "pane-1")).toMatchObject({
      tag: "Err",
      error: { reason: "source_not_found" },
    });
  expect(rows(db)).toEqual([]);
  expect(panes(db)).toEqual([["s1", null]]);
});

test("deleted sources and a removed project delete their coordination waits", () => {
  using db = fixture();
  source(db, "s1");
  startCoordinationWait(db, all, null);
  startCoordinationWait(db, one, null);
  deleteSourceRecords(drizzle(db), ["s1"]);
  expect(rows(db).map((row) => row.scope)).toEqual([""]);
  expect(removeProject(db, "owner/one").tag).toBe("Ok");
  expect(rows(db)).toEqual([]);
});

test("each write waits for the writer reservation", () => {
  using db = fixture();
  using reserved = reservedCopy(db);
  expect(startCoordinationWait(reserved.subject, all, null)).toMatchObject(busy);
  expect(finishCoordinationWait(reserved.subject, all, () => "[]")).toMatchObject(busy);
  expect(renewCoordinationWait(reserved.subject, all)).toMatchObject(busy);
  expect(changeCoordinationWait(reserved.subject, all, merged)).toMatchObject(busy);
  expect(acknowledgeCoordinationWaits(reserved.subject, "pane-1", merged)).toMatchObject(busy);
});

test("supervision lists the pane's sources and whether a running wait from that pane covers each", () => {
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
  db.query("UPDATE sources SET supervising_pane = 'pane-1' WHERE id != 's2'").run();
  db.query("UPDATE sources SET supervising_pane = 'other' WHERE id = 's2'").run();
  expect(readSupervision(db, "pane-1")).toMatchObject({
    tag: "Ok",
    value: [
      { id: "s1", repository: "owner/one", waiting: false },
      { id: "s3", repository: "owner/one", waiting: false },
      { id: "s4", repository: "owner/two", waiting: false },
    ],
  });
  // A wait for one source covers only that source, and a project wait covers its project.
  startCoordinationWait(db, one, "pane-1");
  expect(readSupervision(db, "pane-1")).toMatchObject({
    value: [{ waiting: true }, { waiting: false }, { waiting: false }],
  });
  startCoordinationWait(db, { repository: "owner/two", scope: "" }, "pane-1");
  expect(readSupervision(db, "pane-1")).toMatchObject({
    value: [{ waiting: true }, { waiting: false }, { waiting: true }],
  });
});

test("a finished wait, a gone process, or a wait from another pane covers nothing", () => {
  using db = fixture();
  source(db, "s1");
  db.query("UPDATE sources SET supervising_pane = 'pane-1'").run();
  startCoordinationWait(db, all, "pane-2");
  expect(readSupervision(db, "pane-1")).toMatchObject({ value: [{ id: "s1", waiting: false }] });
  startCoordinationWait(db, all, "pane-1");
  expect(readSupervision(db, "pane-1")).toMatchObject({ value: [{ waiting: true }] });
  finishCoordinationWait(db, all, () => "[]");
  expect(readSupervision(db, "pane-1")).toMatchObject({ value: [{ waiting: false }] });
  startCoordinationWait(db, all, "pane-1");
  db.query("UPDATE coordination_waits SET lease_at = '2000-01-01T00:00:00.000Z'").run();
  expect(readSupervision(db, "pane-1")).toMatchObject({ value: [{ waiting: false }] });
  // A pane that supervises nothing has no sources.
  expect(readSupervision(db, "pane-3")).toMatchObject({ tag: "Ok", value: [] });
});

function merged(stored: string | null) {
  return `${stored ?? ""}+b`;
}

test("a finish merges the returned set into the stored set, so an acknowledgement in between stays", () => {
  using db = fixture();
  startCoordinationWait(db, all, "pane-1");
  expect(finishCoordinationWait(db, all, merged)).toMatchObject({ tag: "Ok" });
  expect(rows(db)[0]?.actions).toBe("+b");
  startCoordinationWait(db, all, "pane-1");
  expect(finishCoordinationWait(db, all, merged)).toMatchObject({ tag: "Ok" });
  expect(rows(db)[0]?.actions).toBe("+b+b");
});

test("a read returns the stored set, and a change rewrites only a recorded scope", () => {
  using db = fixture();
  expect(readCoordinationWait(db, all)).toMatchObject({ tag: "Ok", value: null });
  expect(changeCoordinationWait(db, all, merged)).toMatchObject({ tag: "Ok", value: null });
  expect(rows(db)).toEqual([]);
  startCoordinationWait(db, all, "pane-1");
  finishCoordinationWait(db, all, () => "a");
  expect(changeCoordinationWait(db, all, merged)).toMatchObject({ tag: "Ok", value: "a+b" });
  expect(readCoordinationWait(db, all)).toMatchObject({ tag: "Ok", value: "a+b" });
});

test("an acknowledgement changes every returned set of the pane's waits and no other", () => {
  using db = fixture();
  source(db, "s1");
  const pane = { repository: "owner/one", scope: coordinationPaneScope("pane-1") };
  for (const target of [all, one, pane]) {
    startCoordinationWait(db, target, target === one ? "pane-2" : "pane-1");
    finishCoordinationWait(db, target, () => "a");
  }
  startCoordinationWait(db, { repository: "owner/one", scope: "" }, "pane-1");
  db.query("UPDATE coordination_waits SET actions = NULL WHERE scope = ''").run();
  expect(acknowledgeCoordinationWaits(db, "pane-1", merged)).toMatchObject({ tag: "Ok" });
  expect(rows(db).map((row) => [row.scope, row.actions])).toEqual([
    ["", null],
    ["pane:pane-1", "a+b"],
    ["s1", "a"],
  ]);
});

test("a pane wait claims like a project wait and covers every source that its pane supervises", () => {
  using db = fixture();
  registerProject(db, { repository: "owner/two", checkout: "/two", registeredAt: "now" });
  source(db, "s1");
  source(db, "s2");
  source(db, "s4", "open", "owner/two");
  db.query("UPDATE sources SET supervising_pane = 'other' WHERE id = 's2'").run();
  db.query("UPDATE sources SET supervising_pane = 'pane-1' WHERE id = 's4'").run();
  const pane = { repository: "owner/one", scope: coordinationPaneScope("pane-1") };
  expect(startCoordinationWait(db, pane, "pane-1")).toMatchObject({ tag: "Ok", value: null });
  expect(panes(db)).toEqual([
    ["s1", "pane-1"],
    ["s2", "other"],
    ["s4", "pane-1"],
  ]);
  expect(readSupervision(db, "pane-1")).toMatchObject({
    value: [
      { id: "s1", waiting: true },
      { id: "s4", waiting: true },
    ],
  });
  // Another pane's pane wait covers nothing of this pane.
  finishCoordinationWait(db, pane, () => "[]");
  startCoordinationWait(
    db,
    { repository: "owner/one", scope: coordinationPaneScope("pane-2") },
    "pane-1",
  );
  expect(readSupervision(db, "pane-1")).toMatchObject({
    value: [{ waiting: false }, { waiting: false }],
  });
});
