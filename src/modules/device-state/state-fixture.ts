import { Database } from "bun:sqlite";
// Bun has no synchronous file removal API.
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Copy a test database to a file and let a second connection hold the writer reservation.
 * A write operation must then report busy before it reads, even on a path that writes nothing.
 */
export function reservedCopy(db: Database) {
  const file = path.join(tmpdir(), `operator-reserved-${crypto.randomUUID()}.sqlite`);
  db.exec(`VACUUM INTO '${file}'`);
  const subject = new Database(file);
  subject.exec("PRAGMA foreign_keys = ON");
  const competitor = new Database(file);
  competitor.exec("BEGIN IMMEDIATE");
  return {
    subject,
    [Symbol.dispose]() {
      competitor.close();
      subject.close();
      rmSync(file, { force: true });
    },
  };
}

export const busy = { tag: "Err", error: { reason: "state_busy" } };

let placeholders = 0;
/** Insert one row and fill every other required column with a unique placeholder. */
export function insertRow(
  db: Database,
  table: string,
  values: Record<string, string | number | null>,
) {
  const required = db
    .query<{ name: string; notnull: number }, []>(`PRAGMA table_info('${table}')`)
    .all()
    .filter((column) => column.notnull === 1 && !(column.name in values));
  const row = {
    ...Object.fromEntries(required.map((column) => [column.name, `x${++placeholders}`])),
    ...values,
  };
  const names = Object.keys(row);
  db.query(
    `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
  ).run(...Object.values(row));
}
