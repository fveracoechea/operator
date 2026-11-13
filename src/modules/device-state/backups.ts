// Bun has no exclusive synchronous writes or directory listing API.
import { isCodedError } from "../../lib/coded-error.ts";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { fromThrowable, Err, Ok, type Result } from "unthrown";
import { OperatorHome } from "../operator-home/main.ts";
import { historySchema, openDatabase } from "./database.ts";
import { qualifyStateFailure, type StateFailure } from "./failures.ts";
import type { Database } from "bun:sqlite";
import { syncPath } from "./sync.ts";

type Paths = ReturnType<typeof OperatorHome.resolve>;
type VerifiedBackup = { identity: string; database: string; verifiedAt: string };
const receiptSchema = z.strictObject({
  identity: z.string(),
  verifiedAt: z.iso.datetime(),
  hash: z.string(),
  history: historySchema,
});

function backupHistory(client: Database) {
  // A healthy copy returns one row with "ok". Any other result names damage.
  if (client.query("PRAGMA integrity_check").values().join() !== "ok") return null;
  return historySchema.parse(
    client.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id").all(),
  );
}

/** An invalid receipt or copy is skipped, and an unknown failure stays a defect. */
function qualifyBackupFailure<T>(cause: Error, defect: (cause: Error) => T): StateFailure | T {
  if (
    cause instanceof z.ZodError ||
    cause instanceof SyntaxError ||
    (isCodedError(cause) && cause.code === "SQLITE_ERROR")
  )
    // Stryker disable next-line ObjectLiteral,StringLiteral: equivalent: discovery skips every refused copy, so this reason and detail never reach a caller
    return { reason: "state_backup_failed", detail: "The backup receipt or history is invalid." };
  return qualifyStateFailure(cause, defect);
}

function backupNames(paths: Paths) {
  let names: string[];
  try {
    names = readdirSync(paths.backups);
  } catch (cause) {
    // Stryker disable next-line ArrayDeclaration: equivalent: a listed name with no receipt fails to read, and discovery skips it
    if (isCodedError(cause) && cause.code === "ENOENT") return [];
    // oxlint-disable-next-line unthrown/no-throw -- The storage boundary preserves unreadable backup evidence.
    throw cause;
  }
  return names;
}

export function verifiedBackups(paths: Paths) {
  return fromThrowable(
    (): Result<VerifiedBackup[], StateFailure> => {
      const verified: VerifiedBackup[] = [];
      for (const identity of backupNames(paths)) {
        const files = OperatorHome.migrationBackup(paths, identity);
        const result = fromThrowable(
          () => {
            const receipt = receiptSchema.parse(JSON.parse(String(readFileSync(files.receipt))));
            if (
              receipt.identity !== identity ||
              new Bun.CryptoHasher("sha256").update(readFileSync(files.database)).digest("hex") !==
                receipt.hash
            )
              return;
            // Stryker disable next-line BooleanLiteral: equivalent: this connection only reads, and query_only refuses nothing a read needs
            using db = openDatabase(files.database, true);
            if (JSON.stringify(backupHistory(db)) !== JSON.stringify(receipt.history)) return;
            return { identity, database: files.database, verifiedAt: receipt.verifiedAt };
          },
          (cause, defect) =>
            cause instanceof Error ? qualifyBackupFailure(cause, defect) : defect(cause),
        )();
        // Stryker disable next-line ArrowFunction,ArrayDeclaration: equivalent: map never calls its function on a Defect, which it only retypes
        if (result.tag === "Defect") return result.map(() => []);
        // Stryker disable next-line ConditionalExpression: equivalent: an Err carries no value, so the tag check only narrows the type
        if (result.tag === "Ok" && result.value) verified.push(result.value);
      }
      return Ok(
        verified.toSorted(
          (a, b) =>
            b.verifiedAt.localeCompare(a.verifiedAt) || b.identity.localeCompare(a.identity),
        ),
      );
    },
    (cause, defect) =>
      cause instanceof Error ? qualifyStateFailure(cause, defect) : defect(cause),
  )().flatMap((result) => result);
}

/** SQLite serialization takes the locked connection's snapshot, never live database side files. */
export function createBackup(
  client: Database,
  paths: Paths,
  history: z.infer<typeof historySchema>,
) {
  return fromThrowable(
    () => {
      const identity = `${new Date().toISOString().replaceAll(":", "-")}-${crypto.randomUUID()}`;
      const files = OperatorHome.migrationBackup(paths, identity);
      mkdirSync(paths.backups, { recursive: true, mode: 0o700 });
      // The new folder is exclusive, so the files below are new too.
      mkdirSync(files.directory, { mode: 0o700 });
      writeFileSync(files.database, client.serialize(), { mode: 0o600 });
      // Stryker disable next-line CallExpression: no rule: a running process cannot observe whether bytes reached stable storage
      syncPath(files.database);
      // Stryker disable next-line BooleanLiteral: equivalent: this connection only reads, and query_only refuses nothing a read needs
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
      writeFileSync(files.receipt, JSON.stringify(receipt), { mode: 0o600 });
      // Stryker disable next-line CallExpression: no rule: a running process cannot observe whether bytes reached stable storage
      syncPath(files.receipt);
      // Stryker disable next-line CallExpression: no rule: a running process cannot observe whether bytes reached stable storage
      syncPath(files.directory);
      // Stryker disable next-line CallExpression: no rule: a running process cannot observe whether bytes reached stable storage
      syncPath(paths.backups);
      return Ok(files.database);
    },
    (cause, defect) =>
      cause instanceof Error ? qualifyStateFailure(cause, defect) : defect(cause),
  )().flatMap((result) => result);
}

export function pruneBackups(paths: Paths) {
  return verifiedBackups(paths).flatMap((backups) =>
    fromThrowable(
      () => {
        for (const backup of backups.slice(3)) {
          rmSync(OperatorHome.migrationBackup(paths, backup.identity).directory, {
            recursive: true,
          });
        }
      },
      (cause, defect) =>
        cause instanceof Error ? qualifyStateFailure(cause, defect) : defect(cause),
    )(),
  );
}
