import { fromThrowable, Err, Ok, type Result } from "unthrown";
import type { OperatorHome } from "../operator-home/main.ts";
import { databaseExists } from "./creation.ts";
import { openDatabase, readHistory, transaction } from "./database.ts";
import { createBackup, pruneBackups, verifiedBackups } from "./backups.ts";
import { idleForMigration, migrationBlockers } from "./migration-policy.ts";
import { qualifyStateFailure, type StateFailure } from "./failures.ts";

type Paths = ReturnType<typeof OperatorHome.resolve>;

function upgrade(paths: Paths) {
  using client = openDatabase(paths.database, false);
  return transaction(client, true, () =>
    readHistory(client).flatMap(({ recorded, shipped }): Result<boolean, StateFailure> => {
      if (recorded.length === shipped.length) return Ok(false);
      const idle = idleForMigration(client, recorded.length);
      if (idle.tag !== "Ok") return idle.map(() => false);
      const pending = shipped.slice(recorded.length);
      for (const migration of pending) {
        const blockers = migrationBlockers(client, migration.folderMillis);
        if (blockers.tag !== "Ok") return blockers.map(() => false);
      }
      const backup = createBackup(client, paths, recorded);
      if (backup.tag !== "Ok") return backup.map(() => false);
      for (const migration of pending) {
        for (const sql of migration.sql) client.exec(sql);
        client
          .query("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
          .run(migration.hash, migration.folderMillis);
      }
      return readHistory(client).map(() => true);
    }),
  );
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
      using reader = openDatabase(paths.database, true);
      const current = transaction(reader, false, () => readHistory(reader));
      if (current.tag !== "Ok") return current.map(() => undefined);
      if (current.value.recorded.length === current.value.shipped.length) return Ok(undefined);
      reader.close();
      const upgraded = upgrade(paths);
      if (upgraded.tag !== "Ok") return upgraded.map(() => undefined);
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
