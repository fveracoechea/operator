// Bun has no synchronous directory inspection, removal, or creation API.
import { isCodedError } from "../../lib/coded-error.ts";
import { lstatSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { Err, Ok, fromThrowable, type Result } from "unthrown";
import { OperatorHome } from "../operator-home/main.ts";
import { checkHistory, transaction } from "./database.ts";
import { projectRemovals, projects } from "./schema.ts";
import { qualifyStateFailure } from "./failures.ts";
import type { ProjectStateFailure, RegisteredProject } from "./projects.ts";
import { syncPath } from "./sync.ts";

type Paths = ReturnType<typeof OperatorHome.resolve>;

/** The caller names the refusal, so its own record states what stays pending. */
function checkDirectory<R extends string>(root: string, directory: string, reason: R) {
  return fromThrowable(
    () => {
      let current = root;
      for (const segment of ["", ...path.relative(root, directory).split(path.sep)]) {
        current = path.join(current, segment);
        try {
          const info = lstatSync(current);
          // Stryker disable next-line ConditionalExpression: equivalent: lstat never reports a link as a directory, so the first check already refuses a link
          if (!info.isDirectory() || info.isSymbolicLink())
            return Err({
              reason,
              detail: `The state path is not a real directory: ${current}. Preserve external content and resolve this path before repeating the command.`,
            });
        } catch (cause) {
          if (isCodedError(cause) && cause.code === "ENOENT") return Ok(undefined);
          // oxlint-disable-next-line unthrown/no-throw -- The state boundary qualifies filesystem failures.
          throw cause;
        }
      }
      return Ok(undefined);
    },
    (cause, defect) =>
      cause instanceof Error ? qualifyStateFailure(cause, defect) : defect(cause),
  )().flatMap((result) => result);
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
        fromThrowable(
          () => {
            mkdirSync(directory, { recursive: true, mode: 0o700 });
            return undefined;
          },
          (cause, defect) =>
            cause instanceof Error ? qualifyStateFailure(cause, defect) : defect(cause),
        )(),
      );
    }),
  );
}

/**
 * Delete one state directory and synchronize its parent. A linked ancestor or a
 * non-directory refuses, so external content stays. The caller holds the writer reservation.
 */
export function removeStateDirectory<R extends string>(root: string, directory: string, reason: R) {
  return checkDirectory(root, directory, reason).flatMap(() =>
    fromThrowable(
      () => {
        rmSync(directory, { recursive: true, force: true });
        try {
          syncPath(path.dirname(directory));
        } catch (cause) {
          // A missing parent means the removal changed no directory entry.
          // oxlint-disable-next-line unthrown/no-throw -- The state boundary qualifies filesystem failures, and the caller keeps its record.
          if (!(isCodedError(cause) && cause.code === "ENOENT")) throw cause;
        }
        return undefined;
      },
      (cause, defect) =>
        cause instanceof Error ? qualifyStateFailure(cause, defect) : defect(cause),
    )(),
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
