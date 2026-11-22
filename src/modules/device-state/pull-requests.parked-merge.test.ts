import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { migrationsFolder } from "./database.ts";
import { insertRow } from "./state-fixture.ts";
import { checkParkedMergeOwner } from "./pull-requests.ts";

function fixture(filename = ":memory:") {
  const db = new Database(filename);
  migrate(drizzle(db), { migrationsFolder });
  insertRow(db, "sources", { id: "s", repository: "owner/repo", state: "open" });
  insertRow(db, "assignments", { source_id: "s", key: "a", completion: "pr", state: "pr-open" });
  insertRow(db, "launches", {
    id: "l",
    source_id: "s",
    assignment: "a",
    attempt: 1,
    state: "finished",
  });
  insertRow(db, "pull_requests", {
    source_id: "s",
    assignment: "a",
    repository: "owner/repo",
    number: 7,
    branch: "task/a",
    parking: JSON.stringify({ launchId: "l", head: "h", state: "parked" }),
  });
  return db;
}

test("parked merge admission is read-only and accepts only the retained matching head", () => {
  using db = fixture();
  const before = db.serialize();
  expect(checkParkedMergeOwner(db, "l", "h")).toMatchObject({ tag: "Ok" });
  expect(checkParkedMergeOwner(db, "l", "changed")).toMatchObject({
    tag: "Err",
    error: { reason: "pr_owner_inactive" },
  });
  expect(db.serialize()).toEqual(before);
  db.exec("UPDATE launches SET state = 'running'");
  expect(checkParkedMergeOwner(db, "l", "h")).toMatchObject({
    tag: "Err",
    error: {
      reason: "pr_owner_inactive",
      detail:
        "The selected parked PR has an active or changed owner. Nothing was read from GitHub or changed.",
      next: {
        command: "operator next",
        why: "Read the assignment's current owner before merging.",
      },
    },
  });
});

test("parked merge admission remains available while another connection holds a write reservation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "operator-parked-admission-"));
  try {
    using writer = fixture(`${root}/state.sqlite`);
    using reader = new Database(`${root}/state.sqlite`);
    writer.exec("BEGIN IMMEDIATE");
    expect(checkParkedMergeOwner(reader, "l", "h")).toMatchObject({ tag: "Ok" });
    writer.exec("ROLLBACK");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrated parked merge admission shares the historical-owner and newer-launch fences", () => {
  using db = fixture();
  db.query("UPDATE pull_requests SET parking = ?").run(
    JSON.stringify({ launchId: "l", head: "h", state: "parked", origin: "migration-0026" }),
  );
  db.exec("UPDATE launches SET state = 'interrupted'");
  expect(checkParkedMergeOwner(db, "l", "h")).toMatchObject({ tag: "Ok" });
  db.query("UPDATE launches SET owner_pid = ?, lease_at = ?").run(
    process.pid,
    new Date().toISOString(),
  );
  expect(checkParkedMergeOwner(db, "l", "h")).toMatchObject({
    tag: "Err",
    error: { reason: "pr_owner_inactive" },
  });
  db.exec("UPDATE launches SET owner_pid = NULL, lease_at = NULL");
  insertRow(db, "launches", {
    id: "new",
    source_id: "s",
    assignment: "a",
    attempt: 2,
    state: "running",
  });
  expect(checkParkedMergeOwner(db, "l", "h")).toMatchObject({
    tag: "Err",
    error: { reason: "pr_owner_inactive" },
  });
});
