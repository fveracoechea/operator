import { Database } from "bun:sqlite";

export function open(path: string, create = false): Database {
  const db = new Database(path, { create, strict: true });
  db.run("PRAGMA busy_timeout = 2000; PRAGMA synchronous = FULL;");
  return db;
}

export function initialize(db: Database, state: unknown): void {
  db.run(
    "CREATE TABLE record (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, state TEXT NOT NULL)",
  );
  db.query("INSERT INTO record VALUES (1, 0, ?)").run(JSON.stringify(state));
}

export function read(db: Database): { revision: number; state: unknown } {
  const row = db
    .query<{ revision: number; state: string }, []>(
      "SELECT revision, state FROM record WHERE id = 1",
    )
    .get();
  if (!row) throw new Error("Missing prototype record");
  return { revision: row.revision, state: JSON.parse(row.state) };
}

export function write(db: Database, state: unknown): void {
  db.query("UPDATE record SET state = ?, revision = revision + 1 WHERE id = 1").run(
    JSON.stringify(state),
  );
}
