import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { idleForMigration, migrationBlockers } from "./migration-policy.ts";

test("idle guards cover active assignments on the whole device, not ready or ended work", () => {
  using db = new Database(":memory:");
  expect(idleForMigration(db, 1).tag).toBe("Ok");
  db.exec("CREATE TABLE assignments (state TEXT)");
  for (const state of [
    "ready",
    "merged",
    "completed",
    "abandoned",
    "running",
    "pr-open",
    "reported",
  ]) {
    db.exec("DELETE FROM assignments");
    db.query("INSERT INTO assignments VALUES (?)").run(state);
    expect(idleForMigration(db, 2).tag).toBe(
      ["running", "pr-open", "reported"].includes(state) ? "Err" : "Ok",
    );
  }
});

test("each fixed migration declares its held-record policy and unknown policies refuse", () => {
  using db = new Database(":memory:");
  expect(migrationBlockers(db, 1792968033776).tag).toBe("Ok");
  expect(migrationBlockers(db, 1793024341510).tag).toBe("Ok");
  expect(migrationBlockers(db, 1793031772449).tag).toBe("Ok");
  expect(migrationBlockers(db, 1793114012060).tag).toBe("Ok");
  expect(migrationBlockers(db, 9999999999999)).toMatchObject({
    tag: "Err",
    error: { reason: "state_incompatible" },
  });
});

test("pending project file cleanup blocks an upgrade across the device until recovered", () => {
  using db = new Database(":memory:");
  db.exec("CREATE TABLE assignments (state TEXT); CREATE TABLE project_removals (repository TEXT)");
  expect(idleForMigration(db, 3).tag).toBe("Ok");
  db.exec("INSERT INTO project_removals VALUES ('owner/removed')");
  expect(idleForMigration(db, 3)).toMatchObject({
    tag: "Err",
    error: { reason: "state_migration_blocked" },
  });
  db.exec("DELETE FROM project_removals");
  expect(idleForMigration(db, 3).tag).toBe("Ok");
});

test("live launches and running preparations block an upgrade, abandoned ones do not", () => {
  using db = new Database(":memory:");
  db.exec(
    "CREATE TABLE assignments (state TEXT); CREATE TABLE project_removals (repository TEXT); CREATE TABLE launches (state TEXT, owner_pid INTEGER, lease_at TEXT); CREATE TABLE worktree_preparations (state TEXT, owner_pid INTEGER, lease_at TEXT)",
  );
  expect(migrationBlockers(db, 1793066920427).tag).toBe("Ok");
  const lease = new Date().toISOString();
  const stoppedPid = Bun.spawnSync([process.execPath, "--version"]).pid;
  for (const state of ["starting", "running", "failed", "interrupted"]) {
    db.exec("DELETE FROM launches");
    db.query("INSERT INTO launches VALUES (?, ?, ?)").run(state, process.pid, lease);
    expect(idleForMigration(db, 4).tag).toBe(
      ["starting", "running"].includes(state) ? "Err" : "Ok",
    );
  }
  // A start whose dispatching process stopped is abandoned, so it does not hold the upgrade.
  db.query("UPDATE launches SET state = 'starting', owner_pid = ?").run(stoppedPid);
  expect(idleForMigration(db, 4).tag).toBe("Ok");
  db.exec("DELETE FROM launches");
  db.query("INSERT INTO worktree_preparations VALUES ('running', ?, ?)").run(process.pid, lease);
  expect(idleForMigration(db, 4)).toMatchObject({
    tag: "Err",
    error: { reason: "state_migration_blocked" },
  });
  db.query("UPDATE worktree_preparations SET owner_pid = ?").run(stoppedPid);
  expect(idleForMigration(db, 4).tag).toBe("Ok");
  db.query("UPDATE worktree_preparations SET state = 'failed', owner_pid = ?").run(process.pid);
  expect(idleForMigration(db, 4).tag).toBe("Ok");
});
