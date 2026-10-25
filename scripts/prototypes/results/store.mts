import { Database, SQLiteError } from "bun:sqlite";
import { diagnostic, err, type Diagnostic, type Result } from "./model.mts";

export type StoreError = {
  type: "store";
  code: "busy" | "constraint" | "injected";
  cause: Diagnostic;
};
export function open(root: string, create = false): Database {
  const db = new Database(`${root}/prototype.sqlite`, { create, strict: true });
  db.run("PRAGMA busy_timeout=500; PRAGMA synchronous=FULL;");
  return db;
}
export function initialize(db: Database, state: unknown): void {
  db.run(
    "CREATE TABLE record (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, state TEXT NOT NULL)",
  );
  db.query("INSERT INTO record VALUES (1,0,?)").run(JSON.stringify(state));
}
export function read(db: Database): { revision: number; state: unknown } {
  const row = db
    .query<{ revision: number; state: string }, []>("SELECT revision,state FROM record WHERE id=1")
    .get();
  if (!row) throw new Error("Missing experiment record");
  return { revision: row.revision, state: JSON.parse(row.state) };
}
export function write(db: Database, state: unknown): void {
  db.query("UPDATE record SET revision=revision+1,state=? WHERE id=1").run(JSON.stringify(state));
}

// SQLite commits any normal return, including Err. The adapter must force a rollback first.
export function transaction<T, E>(
  db: Database,
  work: () => Result<T, E>,
): Result<T, E | StoreError> {
  const rollback = Symbol("rollback-result");
  let result: Result<T, E> | undefined;
  try {
    return db
      .transaction(() => {
        result = work();
        if (!result.ok) throw rollback;
        return result;
      })
      .immediate();
  } catch (cause) {
    if (cause === rollback && result !== undefined) return result;
    if (
      cause instanceof SQLiteError &&
      (cause.code === "SQLITE_BUSY" || cause.code?.startsWith("SQLITE_CONSTRAINT"))
    ) {
      return err({
        type: "store",
        code: cause.code === "SQLITE_BUSY" ? "busy" : "constraint",
        cause: diagnostic(cause),
      });
    }
    throw cause;
  }
}
