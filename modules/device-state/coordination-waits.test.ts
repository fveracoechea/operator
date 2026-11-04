import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { migrationsFolder } from "./database.ts";
import { registerProject, removeProject } from "./projects.ts";
import { deleteSourceRecords, registerSource } from "./sources.ts";
import {
  finishCoordinationWait,
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
  expect(finishCoordinationWait(db, all, '["a"]')).toMatchObject({ tag: "Ok", value: undefined });
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
  finishCoordinationWait(db, all, "[]");
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

test("deleted sources and a removed project delete their coordination waits", () => {
  using db = fixture();
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
  expect(finishCoordinationWait(reserved.subject, all, "[]")).toMatchObject(busy);
  expect(renewCoordinationWait(reserved.subject, all)).toMatchObject(busy);
});
