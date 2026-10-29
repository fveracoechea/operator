import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Err, Ok, fromThrowable } from "unthrown";
// Bun has no descriptor listing, positioned write, temporary-directory, or recursive removal API.
import { closeSync, openSync, readdirSync, writeSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  checkHistory,
  migrationsFolder,
  openDatabase,
  readHistory,
  transaction,
} from "./database.ts";

const shipped = readMigrationFiles({ migrationsFolder });

const root = await mkdtemp(path.join(tmpdir(), "operator-database-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("opens only existing files and explicitly selects full synchronization and a busy timeout", () => {
  expect(() => openDatabase(`${root}/missing`, false)).toThrow();
  using created = new Database(`${root}/existing`);
  expect(created.filename).toBe(`${root}/existing`);
  using client = openDatabase(`${root}/existing`, false);
  expect(client.query("PRAGMA synchronous").values()).toEqual([[2]]);
  expect(client.query("PRAGMA busy_timeout").values()).toEqual([[5000]]);
  expect(client.query("PRAGMA foreign_keys").values()).toEqual([[1]]);
  expect(checkHistory(client)).toMatchObject({
    tag: "Err",
    error: { reason: "state_incompatible" },
  });
  expect(client.query("SELECT name FROM sqlite_master").all()).toEqual([]);
  // A writer writes, and named parameters bind without a prefix.
  client.exec("CREATE TABLE records (value TEXT)");
  client.query("INSERT INTO records VALUES ($value)").run({ value: "written" });
  expect(client.query("SELECT value FROM records").all()).toEqual([{ value: "written" }]);
  // Strict binding refuses a missing named parameter instead of binding NULL.
  expect(() => client.query("INSERT INTO records VALUES ($value)").run({})).toThrow(
    'Missing parameter "value"',
  );
});

test("a file that SQLite cannot use is refused without a leaked descriptor", async () => {
  await Bun.write(`${root}/not-a-database`, "x".repeat(4096));
  const open = readdirSync("/dev/fd").length;
  expect(() => openDatabase(`${root}/not-a-database`, false)).toThrow(
    expect.objectContaining({ code: "SQLITE_NOTADB" }),
  );
  expect(readdirSync("/dev/fd")).toHaveLength(open);
});

test("a damaged page fails the integrity check before the history is read", () => {
  const file = `${root}/damaged`;
  {
    using db = new Database(file);
    shippedHistory(db);
    db.exec("CREATE TABLE filler (value TEXT)");
    for (let index = 0; index < 200; index++)
      db.query("INSERT INTO filler VALUES (?)").run("x".repeat(100));
  }
  {
    using healthy = new Database(file);
    expect(readHistory(healthy).tag).toBe("Ok");
  }
  const fd = openSync(file, "r+");
  try {
    // Byte 5 of a b-tree page header points at its cell content area.
    writeSync(fd, new Uint8Array([0xff]), 0, 1, 3 * 4096 + 5);
  } finally {
    closeSync(fd);
  }
  using damaged = new Database(file);
  expect(readHistory(damaged)).toMatchObject({
    tag: "Err",
    error: {
      reason: "state_corrupt",
      detail: "The device database failed its integrity check. It was not repaired or replaced.",
    },
  });
});

test("a reader opens a closed WAL database and refuses writes", async () => {
  const created = new Database(`${root}/wal`);
  created.exec("PRAGMA journal_mode = WAL; CREATE TABLE records (value TEXT)");
  created.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  created.close();
  // A closed WAL database can lack its shared-memory file, which a macOS read-only open cannot create.
  await rm(`${root}/wal-wal`, { force: true });
  await rm(`${root}/wal-shm`, { force: true });
  expect(() => openDatabase(`${root}/missing`, true)).toThrow();
  using reader = openDatabase(`${root}/wal`, true);
  expect(reader.query("SELECT count(*) FROM records").values()).toEqual([[0]]);
  expect(() => reader.exec("INSERT INTO records VALUES ('written')")).toThrow("readonly");
  expect(reader.query("SELECT count(*) FROM records").values()).toEqual([[0]]);
});

test("commits only Ok and rolls back Err, Defect, and thrown defects", () => {
  using db = new Database(":memory:");
  db.exec("CREATE TABLE records (value TEXT)");
  for (const mode of ["ok", "err", "defect", "throw"]) {
    const result = transaction(db, true, () => {
      db.query("INSERT INTO records VALUES (?)").run(mode);
      if (mode === "err") return Err("refused");
      if (mode === "defect")
        return fromThrowable(
          () => JSON.parse("bad") as unknown,
          (cause, defect) => defect(cause),
        )();
      if (mode === "throw") {
        // oxlint-disable-next-line unthrown/no-throw -- Deliberate break proves transaction rollback on a defect.
        throw new TypeError("deliberate defect");
      }
      return Ok(mode);
    });
    expect(result.tag).toBe(mode === "ok" ? "Ok" : mode === "err" ? "Err" : "Defect");
    expect(db.inTransaction).toBe(false);
    expect(db.query("SELECT value FROM records").all()).toEqual([{ value: "ok" }]);
  }
});

test("reads a consistent snapshot while another real SQLite connection commits", () => {
  using reader = new Database(`${root}/snapshot`);
  reader.exec(
    "PRAGMA journal_mode = WAL; CREATE TABLE records (value TEXT); INSERT INTO records VALUES ('before')",
  );
  using writer = new Database(`${root}/snapshot`);
  const result = transaction(reader, false, () => {
    const before = reader.query("SELECT value FROM records").all();
    writer.exec("BEGIN IMMEDIATE; UPDATE records SET value = 'after'; COMMIT");
    const after = reader.query("SELECT value FROM records").all();
    return Ok({ before, after });
  });
  expect(result).toMatchObject({
    tag: "Ok",
    value: { before: [{ value: "before" }], after: [{ value: "before" }] },
  });
  expect(reader.query("SELECT value FROM records").all()).toEqual([{ value: "after" }]);
});

test("a write transaction reserves its lock before its first statement", () => {
  using writer = new Database(`${root}/immediate`);
  using competitor = new Database(`${root}/immediate`);
  competitor.exec("PRAGMA busy_timeout = 1");
  const result = transaction(writer, true, () => {
    const competing = fromThrowable(
      () => competitor.exec("BEGIN IMMEDIATE"),
      (cause) => String(cause),
    )();
    if (competitor.inTransaction) competitor.exec("ROLLBACK");
    return Ok(competing.tag);
  });
  expect(result).toMatchObject({ tag: "Ok", value: "Err" });
});

function shippedHistory(db: Database, count = shipped.length) {
  db.exec(
    "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)",
  );
  for (const migration of shipped.slice(0, count))
    db.query("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(
      migration.hash,
      migration.folderMillis,
    );
}

const unsupported = {
  tag: "Err",
  error: {
    reason: "state_incompatible",
    detail:
      "The device database history is newer, conflicting, or unsupported by this running release. No handler ran.",
  },
};

test("reads a history that matches a prefix of the shipped migrations", () => {
  using db = new Database(":memory:");
  expect(readHistory(db)).toMatchObject({
    tag: "Err",
    error: {
      reason: "state_incompatible",
      detail:
        "The device database has no Drizzle migration history. It was not adopted or repaired.",
    },
  });
  shippedHistory(db, 2);
  const two = shipped.slice(0, 2).map(({ hash, folderMillis }) => ({
    hash,
    created_at: folderMillis,
  }));
  expect(readHistory(db)).toMatchObject({ tag: "Ok", value: { recorded: two, shipped } });
  expect(checkHistory(db)).toMatchObject({
    tag: "Err",
    error: {
      reason: "state_incompatible",
      detail:
        "Startup compatibility must apply the pending shipped migrations before this operation.",
    },
  });
  db.exec("DROP TABLE __drizzle_migrations");
  shippedHistory(db);
  expect(readHistory(db).tag).toBe("Ok");
  expect(checkHistory(db).tag).toBe("Ok");
});

test("refuses empty, longer, conflicting, and malformed histories", () => {
  for (const change of [
    "DELETE FROM __drizzle_migrations",
    "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('future', 9999999999999)",
    "UPDATE __drizzle_migrations SET hash = 'foreign' WHERE id = 2",
    "UPDATE __drizzle_migrations SET created_at = 1 WHERE id = 2",
    "UPDATE __drizzle_migrations SET created_at = NULL WHERE id = 1",
  ]) {
    using db = new Database(":memory:");
    shippedHistory(db);
    db.exec(change);
    expect(readHistory(db), change).toMatchObject(unsupported);
  }
  for (const column of ["id", "hash", "created_at"]) {
    using db = new Database(":memory:");
    shippedHistory(db);
    db.exec(`ALTER TABLE __drizzle_migrations RENAME COLUMN ${column} TO other`);
    expect(readHistory(db), column).toMatchObject({
      tag: "Err",
      error: {
        reason: "state_incompatible",
        detail: "The Drizzle history table has an unsupported format.",
      },
    });
  }
});
