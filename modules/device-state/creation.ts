// Bun has no exclusive file creation, hard-link publication, or directory sync API.
import { linkSync, mkdirSync, openSync, closeSync, fsyncSync, rmSync, lstatSync } from "node:fs";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { fromThrowable, Ok } from "unthrown";
import type { OperatorHome } from "../operator-home/main.ts";
import { OperatorHome as Home } from "../operator-home/main.ts";
import { errorCode, qualifyStateFailure } from "./failures.ts";
import { migrationsFolder, openDatabase } from "./database.ts";
import { registerProject, type RegisteredProject } from "./projects.ts";

type Paths = ReturnType<typeof OperatorHome.resolve>;

export function databaseExists(file: string) {
  try {
    return lstatSync(file).isFile();
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return false;
    // oxlint-disable-next-line unthrown/no-throw -- Only absence permits explicit database creation.
    throw cause;
  }
}

/** A hard link publishes complete bytes without replacing a concurrent winner. */
export function createDatabase(paths: Paths, project: RegisteredProject) {
  return fromThrowable(() => {
    mkdirSync(paths.stateRoot, { recursive: true, mode: 0o700 });
    const temporary = Home.registrationDatabase(paths, crypto.randomUUID());
    const file = openSync(temporary, "wx", 0o600);
    closeSync(file);
    try {
      using client = openDatabase(temporary, false);
      migrate(drizzle(client), { migrationsFolder });
      const result = registerProject(client, project);
      if (result.tag !== "Ok") return result;
      client.close();
      const synced = openSync(temporary, "r");
      try {
        fsyncSync(synced);
      } finally {
        closeSync(synced);
      }
      try {
        linkSync(temporary, paths.database);
      } catch (cause) {
        if (errorCode(cause) !== "EEXIST") {
          // oxlint-disable-next-line unthrown/no-throw -- Preserve any failure other than a concurrent publication.
          throw cause;
        }
        using winner = openDatabase(paths.database, false);
        return registerProject(winner, project);
      }
      const directory = openSync(paths.stateRoot, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      return Ok(result.value);
    } finally {
      rmSync(temporary, { force: true });
    }
  }, qualifyStateFailure)().flatMap((result) => result);
}
