import { all, fromThrowable, Err, Ok, type Result } from "unthrown";
import type { OperatorHome } from "../operator-home/main.ts";
import { databaseExists } from "./creation.ts";
import { openDatabase, readHistory, transaction } from "./database.ts";
import { createBackup, pruneBackups, verifiedBackups } from "./backups.ts";
import { idleForMigration, migrationBlockers } from "./migration-policy.ts";
import { qualifyStateFailure, type StateFailure } from "./failures.ts";

type Paths = ReturnType<typeof OperatorHome.resolve>;

function upgrade(paths: Paths) {
  using client = openDatabase(paths.database, false);
  // Stryker disable next-line BooleanLiteral: equivalent: one synchronous call leaves no other connection a turn between BEGIN and the first write, so only concurrent processes observe the early reservation
  return transaction(client, true, () =>
    readHistory(client).flatMap(({ recorded, shipped }): Result<boolean, StateFailure> => {
      // Stryker disable next-line ConditionalExpression,EqualityOperator,BooleanLiteral: equivalent: the reader returns first when the history matches, so only a concurrent upgrade between the two transactions reaches this check
      if (recorded.length === shipped.length) return Ok(false);
      const pending = shipped.slice(recorded.length);
      return idleForMigration(client, recorded.length)
        .flatMap(() =>
          all(pending.map((migration) => migrationBlockers(client, migration.folderMillis))),
        )
        .flatMap(() => createBackup(client, paths, recorded))
        .flatMap(() => {
          for (const migration of pending) {
            for (const sql of migration.sql) client.exec(sql);
            client
              .query("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
              .run(migration.hash, migration.folderMillis);
          }
          return readHistory(client);
        })
        .map(() => true);
    }),
  );
}

function readCurrent(paths: Paths) {
  // Stryker disable next-line BooleanLiteral: equivalent: this connection only reads, and query_only refuses nothing a read needs
  using reader = openDatabase(paths.database, true);
  return transaction(reader, false, () => readHistory(reader));
}

/** Missing state is never created here. Only explicit project registration can publish it. */
export function compatibility(paths: Paths, firstRegistration = false) {
  const result = fromThrowable(
    (): Result<void, StateFailure> => {
      if (!databaseExists(paths.database))
        return firstRegistration
          ? Ok(undefined)
          : Err<StateFailure>({
              reason: "state_missing",
              detail:
                "The device database is missing. Run operator project register explicitly in the controlling checkout before any other command.",
            });
      const current = readCurrent(paths);
      if (current.tag !== "Ok") return current.map(() => undefined);
      if (current.value.recorded.length === current.value.shipped.length) return Ok(undefined);
      const upgraded = upgrade(paths);
      if (upgraded.tag !== "Ok") return upgraded.map(() => undefined);
      // Stryker disable next-line ConditionalExpression: equivalent: a concurrent upgrade already pruned to the newest three verified backups, so pruning again removes nothing
      if (upgraded.value) return pruneBackups(paths);
      return Ok(undefined);
    },
    (cause, defect) =>
      cause instanceof Error ? qualifyStateFailure(cause, defect) : defect(cause),
  )().flatMap((value) => value);
  if (result.tag === "Err" && result.error.reason === "state_corrupt") {
    const backups = verifiedBackups(paths);
    if (backups.tag !== "Ok") return backups.map(() => undefined);
    const last = backups.value[0]?.database;
    return Err<StateFailure>({
      ...result.error,
      detail: `${result.error.detail} ${last ? `Last verified backup: ${last}` : "No verified migration backup is available."}`,
    });
  }
  return result;
}
