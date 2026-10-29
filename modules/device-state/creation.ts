// Bun has no exclusive file creation or hard-link publication API.
import { isCodedError } from "../../lib/coded-error.ts";
import { linkSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { fromThrowable, Ok } from "unthrown";
import type { OperatorHome } from "../operator-home/main.ts";
import { OperatorHome as Home } from "../operator-home/main.ts";
import { qualifyStateFailure } from "./failures.ts";
import { migrationsFolder, openDatabase } from "./database.ts";
import { registerProject, type RegisteredProject } from "./projects.ts";
import { syncPath } from "./sync.ts";

type Paths = ReturnType<typeof OperatorHome.resolve>;

export function databaseExists(file: string) {
  try {
    if (!lstatSync(file).isFile()) {
      // oxlint-disable-next-line unthrown/no-throw -- Unsupported paths must refuse before SQLite can follow or adopt them.
      throw Object.assign(
        new Error("The device database must be a regular file, not a link or directory."),
        { code: "STATE_UNSUPPORTED" },
      );
    }
    return true;
  } catch (cause) {
    if (isCodedError(cause) && cause.code === "ENOENT") return false;
    // oxlint-disable-next-line unthrown/no-throw -- Only absence permits explicit database creation.
    throw cause;
  }
}

function initialize(file: string, project: RegisteredProject) {
  using client = openDatabase(file, false);
  migrate(drizzle(client), { migrationsFolder });
  return registerProject(client, project);
}

/** A hard link publishes complete bytes without replacing a concurrent winner. */
export function createDatabase(paths: Paths, project: RegisteredProject) {
  return fromThrowable(
    () => {
      mkdirSync(paths.stateRoot, { recursive: true, mode: 0o700 });
      const temporary = Home.registrationDatabase(paths, crypto.randomUUID());
      writeFileSync(temporary, "", { flag: "wx", mode: 0o600 });
      try {
        const result = initialize(temporary, project);
        // Stryker disable next-line ConditionalExpression: equivalent: a freshly migrated database has no project, removal, or checkout that could refuse the registration
        if (result.tag !== "Ok") return result;
        // Stryker disable next-line CallExpression: no rule: a running process cannot observe whether bytes reached stable storage
        syncPath(temporary);
        try {
          linkSync(temporary, paths.database);
        } catch (cause) {
          // Stryker disable next-line ConditionalExpression,LogicalOperator,BlockStatement: no rule: the temporary file shares the folder, so a test cannot make the link fail for a reason other than an existing name
          if (!(isCodedError(cause) && cause.code === "EEXIST")) {
            // oxlint-disable-next-line unthrown/no-throw -- Preserve any failure other than a concurrent publication.
            throw cause;
          }
          using winner = openDatabase(paths.database, false);
          return registerProject(winner, project);
        }
        // Stryker disable next-line CallExpression: no rule: a running process cannot observe whether bytes reached stable storage
        syncPath(paths.stateRoot);
        return Ok(result.value);
      } finally {
        rmSync(temporary);
      }
    },
    (cause, defect) =>
      cause instanceof Error ? qualifyStateFailure(cause, defect) : defect(cause),
  )().flatMap((result) => result);
}
