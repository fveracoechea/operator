import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Err, Ok, fromThrowable } from "unthrown";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkHistory, openDatabase, transaction } from "./database.ts";

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
