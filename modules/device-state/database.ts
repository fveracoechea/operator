import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { fromThrowable, Err, Ok, type Result } from "unthrown";
import { z } from "zod";
import { qualifyStateFailure, type StateFailure } from "./failures.ts";

export const migrationsFolder = Bun.fileURLToPath(new URL("./migrations/", import.meta.url));

export function openDatabase(file: string, readonly: boolean) {
  const client = new Database(
    file,
    readonly ? { readonly: true, strict: true } : { readwrite: true, create: false, strict: true },
  );
  try {
    client.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON");
    return client;
  } catch (cause) {
    client.close();
    // oxlint-disable-next-line unthrown/no-throw -- The state boundary qualifies SQLite failures.
    throw cause;
  }
}

/** Both modeled refusals and defects roll back before this connection leaves the owner. */
export function transaction<T, E>(client: Database, write: boolean, action: () => Result<T, E>) {
  return fromThrowable(() => {
    client.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const result = action();
      if (result.tag === "Ok") client.exec("COMMIT");
      return result;
    } finally {
      if (client.inTransaction) client.exec("ROLLBACK");
    }
  }, qualifyStateFailure)().flatMap((result) => result);
}

const historySchema = z.array(z.object({ hash: z.string(), created_at: z.number() }));

export function checkHistory(client: Database) {
  const integrity = client.query("PRAGMA quick_check").values();
  if (integrity.length !== 1 || integrity[0]?.[0] !== "ok")
    return Err<StateFailure>({
      reason: "state_corrupt",
      detail: "The device database failed its integrity check. It was not repaired or replaced.",
    });
  const exists = client
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get();
  if (exists === null)
    return Err<StateFailure>({
      reason: "state_incompatible",
      detail:
        "The device database has no Drizzle migration history. It was not adopted or repaired.",
    });
  const recorded = historySchema.safeParse(
    client.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id").all(),
  );
  const shipped = readMigrationFiles({ migrationsFolder });
  if (
    !recorded.success ||
    recorded.data.length !== shipped.length ||
    shipped.some(
      (migration, index) =>
        recorded.data[index]?.hash !== migration.hash ||
        recorded.data[index]?.created_at !== migration.folderMillis,
    )
  )
    return Err<StateFailure>({
      reason: "state_incompatible",
      detail:
        "The device database history does not match this running release. Automatic upgrades are not available in this slice. No handler write ran.",
    });
  return Ok(drizzle(client));
}
