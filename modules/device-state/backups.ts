// Bun has no exclusive synchronous writes, directory listing, or directory synchronization API.
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { z } from "zod";
import { fromThrowable, Err, Ok } from "unthrown";
import { OperatorHome } from "../operator-home/main.ts";
import { historySchema, openDatabase } from "./database.ts";
import { errorCode, qualifyStateFailure, type StateFailure } from "./failures.ts";
import type { Database } from "bun:sqlite";

type Paths = ReturnType<typeof OperatorHome.resolve>;
const receiptSchema = z.strictObject({
  identity: z.string(),
  verifiedAt: z.iso.datetime(),
  hash: z.string(),
  history: historySchema,
});

function syncFile(file: string) {
  const fd = openSync(file, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function backupHistory(client: Database) {
  const integrity = client.query("PRAGMA integrity_check").values();
  if (integrity.length !== 1 || integrity[0]?.[0] !== "ok") return null;
  return historySchema.parse(
    client.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id").all(),
  );
}

export function verifiedBackups(paths: Paths) {
  let names: string[];
  try {
    names = readdirSync(paths.backups);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return [];
    // oxlint-disable-next-line unthrown/no-throw -- The storage boundary preserves unreadable backup evidence.
    throw cause;
  }
  const verified: { identity: string; database: string; verifiedAt: string }[] = [];
  for (const identity of names) {
    const files = OperatorHome.migrationBackup(paths, identity);
    const result = fromThrowable(
      () => {
        const receipt = receiptSchema.parse(JSON.parse(readFileSync(files.receipt, "utf8")));
        if (
          receipt.identity !== identity ||
          new Bun.CryptoHasher("sha256").update(readFileSync(files.database)).digest("hex") !==
            receipt.hash
        )
          return;
        using db = openDatabase(files.database, true);
        if (JSON.stringify(backupHistory(db)) !== JSON.stringify(receipt.history)) return;
        return { identity, database: files.database, verifiedAt: receipt.verifiedAt };
      },
      (cause) => String(cause),
    )();
    if (result.tag === "Ok" && result.value) verified.push(result.value);
  }
  return verified.toSorted(
    (a, b) => b.verifiedAt.localeCompare(a.verifiedAt) || b.identity.localeCompare(a.identity),
  );
}

/** SQLite serialization takes the locked connection's snapshot, never live database side files. */
export function createBackup(
  client: Database,
  paths: Paths,
  history: z.infer<typeof historySchema>,
) {
  return fromThrowable(() => {
    const identity = `${new Date().toISOString().replaceAll(":", "-")}-${crypto.randomUUID()}`;
    const files = OperatorHome.migrationBackup(paths, identity);
    mkdirSync(paths.backups, { recursive: true, mode: 0o700 });
    mkdirSync(files.directory, { mode: 0o700 });
    writeFileSync(files.database, client.serialize(), { flag: "wx", mode: 0o600 });
    syncFile(files.database);
    using backup = openDatabase(files.database, true);
    if (JSON.stringify(backupHistory(backup)) !== JSON.stringify(history))
      return Err<StateFailure>({
        reason: "state_backup_failed",
        detail:
          "The migration snapshot failed integrity or history verification. No migration or handler ran.",
      });
    const receipt = {
      identity,
      verifiedAt: new Date().toISOString(),
      hash: new Bun.CryptoHasher("sha256").update(readFileSync(files.database)).digest("hex"),
      history,
    };
    writeFileSync(files.receipt, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
    syncFile(files.receipt);
    syncFile(files.directory);
    syncFile(paths.backups);
    return Ok(files.database);
  }, qualifyStateFailure)().flatMap((result) => result);
}

export function pruneBackups(paths: Paths) {
  for (const backup of verifiedBackups(paths).slice(3)) {
    rmSync(OperatorHome.migrationBackup(paths, backup.identity).directory, { recursive: true });
  }
}
