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
  expect(migrationBlockers(db, 9999999999999)).toMatchObject({
    tag: "Err",
    error: { reason: "state_incompatible" },
  });
});
