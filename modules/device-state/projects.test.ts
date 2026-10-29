import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { migrationsFolder } from "./database.ts";
import {
  registerProject,
  lookupProject,
  listProjects,
  moveProject,
  removeProject,
} from "./projects.ts";
import { busy, insertRow, reservedCopy } from "./state-fixture.ts";

test("uses Drizzle constraints and atomic identity and controller guards", () => {
  using db = new Database(":memory:");
  migrate(drizzle(db), { migrationsFolder });
  const one = {
    repository: "owner/one",
    checkout: "/isolated/one",
    registeredAt: "2026-10-25T00:00:00Z",
  };
  expect(registerProject(db, one)).toMatchObject({
    tag: "Ok",
    value: { reason: "project_registered", data: one },
  });
  expect(registerProject(db, { ...one, registeredAt: "later" })).toMatchObject({
    tag: "Ok",
    value: { reason: "project_unchanged", data: one },
  });
  expect(registerProject(db, { ...one, checkout: "/isolated/alternate" })).toMatchObject({
    tag: "Err",
    error: { reason: "controller_mismatch" },
  });
  expect(registerProject(db, { ...one, repository: "owner/renamed" })).toMatchObject({
    tag: "Err",
    error: { reason: "controller_identity_mismatch" },
  });
  expect(lookupProject(db, one.checkout, [one.repository])).toMatchObject({
    tag: "Ok",
    value: { controller: one, matches: [one] },
  });
  expect(lookupProject(db, "/unregistered", [])).toMatchObject({
    tag: "Ok",
    value: { matches: [] },
  });
  expect(db.query("SELECT repository FROM projects").all()).toEqual([{ repository: "owner/one" }]);
  expect(() =>
    drizzle(db).run("INSERT INTO projects VALUES ('other/repo', '/isolated/one', 'now')"),
  ).toThrow();
});

test("project management preserves scope and leaves a cleanup obligation after atomic record removal", () => {
  using db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(drizzle(db), { migrationsFolder });
  for (const name of ["one", "two"])
    expect(
      registerProject(db, {
        repository: `owner/${name}`,
        checkout: `/${name}`,
        registeredAt: "now",
      }).tag,
    ).toBe("Ok");
  db.exec(
    "INSERT INTO sources VALUES ('source', 'owner/one', 'APP-1', 'open', 'now', NULL, '{}'); INSERT INTO assignments VALUES ('source', 'task', 'report', 'ready')",
  );
  expect(listProjects(db)).toMatchObject({
    tag: "Ok",
    value: {
      projects: [
        { repository: "owner/one", openSources: 1 },
        { repository: "owner/two", openSources: 0 },
      ],
      pendingRemovals: [],
    },
  });
  expect(moveProject(db, "owner/one", "/alternate")).toMatchObject({
    tag: "Err",
    error: { reason: "project_source_open" },
  });
  expect(removeProject(db, "owner/one")).toMatchObject({
    tag: "Err",
    error: { reason: "project_source_open" },
  });
  expect(moveProject(db, "owner/two", "/one")).toMatchObject({
    tag: "Err",
    error: { reason: "controller_identity_mismatch" },
  });
  db.exec(
    "UPDATE sources SET state = 'reset', ended_at = 'later'; UPDATE assignments SET state = 'abandoned'",
  );
  expect(moveProject(db, "owner/one", "/alternate")).toMatchObject({
    tag: "Ok",
    value: { data: { checkout: "/alternate", registeredAt: "now" } },
  });
  expect(removeProject(db, "owner/one").tag).toBe("Ok");
  expect(removeProject(db, "owner/one").tag).toBe("Ok");
  expect(
    registerProject(db, { repository: "owner/one", checkout: "/alternate", registeredAt: "later" }),
  ).toMatchObject({ tag: "Err", error: { reason: "project_cleanup_pending" } });
  expect(db.query("SELECT * FROM sources").all()).toEqual([]);
  expect(db.query("SELECT * FROM assignments").all()).toEqual([]);
  expect(listProjects(db)).toMatchObject({
    tag: "Ok",
    value: {
      projects: [{ repository: "owner/two" }],
      pendingRemovals: [{ repository: "owner/one" }],
    },
  });
  expect(removeProject(db, "owner/absent")).toMatchObject({
    tag: "Err",
    error: { reason: "project_not_registered" },
  });
  expect(moveProject(db, "owner/absent", "/alternate")).toMatchObject({
    tag: "Err",
    error: { reason: "project_not_registered" },
  });
});

function projectDb() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(drizzle(db), { migrationsFolder });
  for (const name of ["one", "two"])
    registerProject(db, { repository: `owner/${name}`, checkout: `/${name}`, registeredAt: "now" });
  return db;
}

function source(db: Database, id: string, state: string, endedAt: string | null) {
  insertRow(db, "sources", { id, repository: "owner/one", state, ended_at: endedAt });
}

test("a source holds its project until it has ended with a final state", () => {
  for (const [state, endedAt, held] of [
    ["open", null, true],
    ["open", "later", true],
    ["finished", null, true],
    ["reset", null, true],
    ["finished", "later", false],
    ["reset", "later", false],
  ] as const) {
    using db = projectDb();
    source(db, "ended", "finished", "later");
    source(db, "subject", state, endedAt);
    function refusal(action: string) {
      return {
        tag: "Err",
        error: {
          reason: "project_source_open",
          detail: `End every open source before ${action} this project.`,
        },
      };
    }
    const label = `${state} ${endedAt}`;
    if (held) {
      expect(moveProject(db, "owner/one", "/alternate"), label).toMatchObject(refusal("moving"));
      expect(removeProject(db, "owner/one"), label).toMatchObject(refusal("removing"));
    } else {
      expect(moveProject(db, "owner/one", "/alternate").tag, label).toBe("Ok");
      expect(removeProject(db, "owner/one").tag, label).toBe("Ok");
    }
  }
});

test("an open cleanup holds its project, and a done cleanup does not", () => {
  using db = projectDb();
  source(db, "s1", "finished", "later");
  insertRow(db, "assignments", { source_id: "s1", key: "task" });
  insertRow(db, "launches", { id: "l1", source_id: "s1", assignment: "task" });
  insertRow(db, "cleanups", {
    source_id: "s1",
    assignment: "task",
    launch_id: "l1",
    state: "failed",
  });
  const open = {
    tag: "Err",
    error: {
      reason: "project_cleanup_open",
      detail: "Finish every open cleanup with operator cleanup first. Read operator next for it.",
    },
  };
  expect(moveProject(db, "owner/one", "/alternate")).toMatchObject(open);
  expect(removeProject(db, "owner/one")).toMatchObject(open);
  db.exec("UPDATE cleanups SET state = 'done'");
  expect(moveProject(db, "owner/one", "/alternate")).toMatchObject({
    tag: "Ok",
    value: {
      reason: "project_moved",
      data: { repository: "owner/one", checkout: "/alternate", registeredAt: "now" },
    },
  });
});

test("an unfinished review request holds its project until it ends and its cleanup finishes", () => {
  using db = projectDb();
  insertRow(db, "review_requests", {
    id: "r1",
    repository: "owner/one",
    number: 7,
    state: "approved",
    cleanup_state: null,
  });
  const open = { tag: "Err", error: { reason: "project_review_open" } };
  for (const [state, cleanup] of [
    ["approved", null],
    ["closed", "pending"],
    ["closed", "failed"],
    ["skipped", "kept"],
  ] as const) {
    db.query("UPDATE review_requests SET state = ?, cleanup_state = ?").run(state, cleanup);
    expect(moveProject(db, "owner/one", "/alternate"), `${state} ${cleanup}`).toMatchObject(open);
    expect(removeProject(db, "owner/one"), `${state} ${cleanup}`).toMatchObject(open);
  }
  db.exec("UPDATE review_requests SET state = 'closed', cleanup_state = 'done'");
  expect(moveProject(db, "owner/one", "/alternate").tag).toBe("Ok");
  db.exec("UPDATE review_requests SET state = 'skipped', cleanup_state = NULL");
  expect(removeProject(db, "owner/one").tag).toBe("Ok");
});

test("removal deletes every record of the project and keeps the other project's records", () => {
  using db = projectDb();
  source(db, "s1", "finished", "later");
  insertRow(db, "sources", { id: "s2", repository: "owner/two", state: "open", ended_at: null });
  for (const id of ["s1", "s2"]) {
    const launch = `${id}-launch`;
    const repository = id === "s1" ? "owner/one" : "owner/two";
    insertRow(db, "assignments", { source_id: id, key: "task" });
    insertRow(db, "launches", { id: launch, source_id: id, assignment: "task" });
    insertRow(db, "pull_requests", { source_id: id, assignment: "task" });
    insertRow(db, "reports", { source_id: id, assignment: "task", launch_id: launch });
    insertRow(db, "cleanups", {
      source_id: id,
      assignment: "task",
      launch_id: launch,
      state: "done",
    });
    insertRow(db, "worktree_preparations", { repository });
  }
  expect(removeProject(db, "owner/one")).toMatchObject({ tag: "Ok", value: undefined });
  for (const table of ["assignments", "launches", "pull_requests", "reports", "cleanups"])
    expect(db.query(`SELECT source_id FROM ${table}`).all(), table).toEqual([{ source_id: "s2" }]);
  expect(db.query("SELECT repository FROM worktree_preparations").all()).toEqual([
    { repository: "owner/two" },
  ]);
  expect(db.query("SELECT id FROM sources").all()).toEqual([{ id: "s2" }]);
});

test("each registration and move refusal names the recorded fact", () => {
  using db = projectDb();
  // A checkout recorded for another identity wins over this identity's own record.
  expect(
    registerProject(db, { repository: "owner/one", checkout: "/two", registeredAt: "now" }),
  ).toMatchObject({
    tag: "Err",
    error: {
      reason: "controller_identity_mismatch",
      detail:
        "This checkout is recorded as owner/two. Restore its remote identity before use. It was not re-registered as owner/one.",
    },
  });
  expect(
    registerProject(db, { repository: "owner/one", checkout: "/moved", registeredAt: "now" }),
  ).toMatchObject({
    tag: "Err",
    error: {
      reason: "controller_mismatch",
      detail:
        "Use the recorded controlling checkout at /one. To change it, run operator project move from a matching main clone when no source is open.",
    },
  });
  expect(moveProject(db, "owner/two", "/one")).toMatchObject({
    tag: "Err",
    error: {
      reason: "controller_identity_mismatch",
      detail: "This checkout is already recorded as owner/one. Its identity was not changed.",
    },
  });
  expect(moveProject(db, "owner/absent", "/absent")).toMatchObject({
    tag: "Err",
    error: {
      reason: "project_not_registered",
      detail: "Register this identity explicitly before moving it.",
    },
  });
  // A move to the recorded checkout is a move of the same identity.
  expect(moveProject(db, "owner/two", "/two")).toMatchObject({
    tag: "Ok",
    value: { data: { checkout: "/two" } },
  });
  expect(removeProject(db, "owner/absent")).toMatchObject({
    tag: "Err",
    error: {
      reason: "project_not_registered",
      detail: "This identity is not registered and has no pending removal.",
    },
  });
  expect(removeProject(db, "owner/two").tag).toBe("Ok");
  expect(
    registerProject(db, { repository: "owner/two", checkout: "/two", registeredAt: "now" }),
  ).toMatchObject({
    tag: "Err",
    error: {
      reason: "project_cleanup_pending",
      detail: "Finish project remove owner/two before registering it again.",
    },
  });
});

test("lists open sources per project, and reads need no writer reservation while changes do", () => {
  using db = projectDb();
  source(db, "open", "open", null);
  source(db, "ended", "finished", "later");
  expect(listProjects(db)).toMatchObject({
    tag: "Ok",
    value: { projects: [{ repository: "owner/one", openSources: 1 }, { openSources: 0 }] },
  });
  using reserved = reservedCopy(db);
  expect(listProjects(reserved.subject).tag).toBe("Ok");
  expect(lookupProject(reserved.subject, "/one", ["owner/one"]).tag).toBe("Ok");
  expect(
    registerProject(reserved.subject, {
      repository: "owner/one",
      checkout: "/one",
      registeredAt: "now",
    }),
  ).toMatchObject(busy);
  expect(removeProject(reserved.subject, "owner/absent")).toMatchObject(busy);
  expect(moveProject(reserved.subject, "owner/absent", "/absent")).toMatchObject(busy);
});
