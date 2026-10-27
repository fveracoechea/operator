// Bun has no synchronous directory inspection, removal, creation, or sync API.
import { lstatSync, mkdirSync, rmSync, openSync, fsyncSync, closeSync } from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { Err, Ok, fromThrowable, type Result } from "unthrown";
import { OperatorHome } from "../operator-home/main.ts";
import { checkHistory, transaction } from "./database.ts";
import { projectRemovals, projects } from "./schema.ts";
import { errorCode, qualifyStateFailure } from "./failures.ts";
import type { ProjectStateFailure, RegisteredProject } from "./projects.ts";

type Paths = ReturnType<typeof OperatorHome.resolve>;

/** The caller names the refusal, so its own record states what stays pending. */
function checkDirectory<R extends string>(root: string, directory: string, reason: R) {
  return fromThrowable(() => {
    let current = root;
    for (const segment of ["", ...path.relative(root, directory).split(path.sep)]) {
      current = path.join(current, segment);
      try {
        const info = lstatSync(current);
        if (!info.isDirectory() || info.isSymbolicLink())
          return Err({
            reason,
            detail: `The state path is not a real directory: ${current}. Preserve external content and resolve this path before repeating the command.`,
          });
      } catch (cause) {
        if (errorCode(cause) === "ENOENT") return Ok(undefined);
        // oxlint-disable-next-line unthrown/no-throw -- The state boundary qualifies filesystem failures.
        throw cause;
      }
    }
    return Ok(undefined);
  }, qualifyStateFailure)().flatMap((result) => result);
}

export function ensureProjectDirectory(client: Database, paths: Paths, project: RegisteredProject) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db): Result<void, ProjectStateFailure> => {
      const current = db
        .select()
        .from(projects)
        .where(eq(projects.repository, project.repository))
        .get();
      if (current?.checkout !== project.checkout)
        return Err({
          reason: "controller_mismatch",
          detail: "The registration changed before its state directory could be created.",
        });
      const directory = OperatorHome.projectDirectory(paths, project.repository);
      return checkDirectory(paths.stateRoot, directory, "project_cleanup_pending").flatMap(() =>
        fromThrowable(() => {
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          return undefined;
        }, qualifyStateFailure)(),
      );
    }),
  );
}

/**
 * Delete one state directory and synchronize the nearest existing parent. A linked ancestor or a
 * non-directory refuses, so external content stays. The caller holds the writer reservation.
 */
export function removeStateDirectory<R extends string>(root: string, directory: string, reason: R) {
  return checkDirectory(root, directory, reason).flatMap(() =>
    fromThrowable(() => {
      rmSync(directory, { recursive: true, force: true });
      // A missing parent means no directory entry remains to synchronize.
      let parent = path.dirname(directory);
      while (true) {
        try {
          const fd = openSync(parent, "r");
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          return undefined;
        } catch (cause) {
          // oxlint-disable-next-line unthrown/no-throw -- The state boundary qualifies filesystem failures, and the caller keeps its record.
          if (errorCode(cause) !== "ENOENT") throw cause;
          parent = path.dirname(parent);
        }
      }
    }, qualifyStateFailure)(),
  );
}

/** The writer reservation prevents registration or another cleaner from racing this deletion. */
export function finishProjectRemoval(client: Database, paths: Paths, repository: string) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) => {
      const pending = db
        .select()
        .from(projectRemovals)
        .where(eq(projectRemovals.repository, repository))
        .get();
      if (!pending) return Ok(undefined);
      return removeStateDirectory(
        paths.stateRoot,
        OperatorHome.projectDirectory(paths, repository),
        "project_cleanup_pending",
      ).map(() => {
        db.delete(projectRemovals).where(eq(projectRemovals.repository, repository)).run();
        return undefined;
      });
    }),
  );
}
