import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { fromThrowable, Err, Ok, type Result } from "unthrown";
import { z } from "zod";
import { qualifyStateFailure, type StateFailure } from "./failures.ts";

export const migrationsFolder = Bun.fileURLToPath(new URL("./migrations/", import.meta.url));

/**
 * A reader opens the existing file read-write and sets `query_only`. The macOS system SQLite
 * cannot open a WAL database read-only while its shared-memory file is absent.
 */
export function openDatabase(file: string, readonly: boolean) {
  const client = new Database(file, { readwrite: true, create: false, strict: true });
  try {
    client.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON");
    if (readonly) client.exec("PRAGMA query_only = ON");
    return client;
  } catch (cause) {
    client.close();
    // oxlint-disable-next-line unthrown/no-throw -- The state boundary qualifies SQLite failures.
    throw cause;
  }
}

/** Both modeled refusals and defects roll back before this connection leaves the owner. */
export function transaction<T, E>(client: Database, write: boolean, action: () => Result<T, E>) {
  return fromThrowable(
    () => {
      client.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
      try {
        const result = action();
        if (result.tag === "Ok") client.exec("COMMIT");
        return result;
      } finally {
        if (client.inTransaction) client.exec("ROLLBACK");
      }
    },
    (cause, defect) =>
      cause instanceof Error ? qualifyStateFailure(cause, defect) : defect(cause),
  )().flatMap((result) => result);
}

export const historySchema = z.array(z.object({ hash: z.string(), created_at: z.number() }));

export function readHistory(client: Database) {
  // A healthy database returns one row with "ok". Any other result names damage.
  if (client.query("PRAGMA quick_check").values().join() !== "ok")
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
  const columns = client.query("PRAGMA table_info('__drizzle_migrations')").values();
  if (!["id", "hash", "created_at"].every((name) => columns.some((column) => column[1] === name)))
    return Err<StateFailure>({
      reason: "state_incompatible",
      detail: "The Drizzle history table has an unsupported format.",
    });
  const recorded = historySchema.safeParse(
    client.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id").all(),
  );
  const shipped = readMigrationFiles({ migrationsFolder });
  if (
    !recorded.success ||
    recorded.data.length === 0 ||
    // A longer history has a recorded migration with no shipped counterpart at its index.
    recorded.data.some(
      (migration, index) =>
        shipped[index]?.hash !== migration.hash ||
        // Stryker disable next-line OptionalChaining: equivalent: the hash comparison before it already refuses an index with no shipped migration
        shipped[index]?.folderMillis !== migration.created_at,
    )
  )
    return Err<StateFailure>({
      reason: "state_incompatible",
      detail:
        "The device database history is newer, conflicting, or unsupported by this running release. No handler ran.",
    });
  return Ok({ recorded: recorded.data, shipped });
}

export function checkHistory(client: Database) {
  return readHistory(client).flatMap(({ recorded, shipped }) =>
    recorded.length === shipped.length
      ? Ok(drizzle(client))
      : Err<StateFailure>({
          reason: "state_incompatible",
          detail:
            "Startup compatibility must apply the pending shipped migrations before this operation.",
        }),
  );
}
