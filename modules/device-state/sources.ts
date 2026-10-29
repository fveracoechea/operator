import { and, asc, eq, inArray } from "drizzle-orm";
// Bun has no synchronous file existence API for directories.
import { existsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Err, Ok, type Result } from "unthrown";
import { checkHistory, transaction } from "./database.ts";
import { ownerGone } from "./leases.ts";
import {
  assignments,
  cleanups,
  launches,
  projects,
  pullRequests,
  reports,
  sources,
} from "./schema.ts";
import type { StateFailure } from "./failures.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { removeStateDirectory } from "./project-files.ts";

export type SourceRow = typeof sources.$inferSelect;
export type AssignmentRow = typeof assignments.$inferSelect;
export type SourceFailure =
  | StateFailure
  | { reason: "source_parent_open" | "source_not_found"; detail: string };

export function registerSource(
  client: Database,
  checkout: string,
  source: SourceRow,
  rows: AssignmentRow[],
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db): Result<SourceRow, SourceFailure> => {
      const controller = db
        .select()
        .from(projects)
        .where(eq(projects.repository, source.repository))
        .get();
      if (controller?.checkout !== checkout)
        return Err({
          reason: "controller_mismatch",
          detail: "The controlling checkout changed before registration. Read the project again.",
        });
      const existing = db
        .select()
        .from(sources)
        .where(
          and(
            eq(sources.repository, source.repository),
            eq(sources.trackerKey, source.trackerKey),
            eq(sources.state, "open"),
          ),
        )
        .get();
      if (existing)
        return Err({
          reason: "source_parent_open",
          detail: `Source ${existing.id} is still open for ${source.trackerKey}.`,
        });
      db.insert(sources).values(source).run();
      if (rows.length > 0) db.insert(assignments).values(rows).run();
      return Ok(source);
    }),
  );
}

export function readSources(client: Database, repository: string, sourceId?: string) {
  return transaction(client, false, () =>
    checkHistory(client).flatMap(
      (
        db,
      ): Result<
        {
          source: SourceRow;
          assignments: AssignmentRow[];
          launches: (typeof launches.$inferSelect & { abandoned: boolean })[];
          pullRequests: (typeof pullRequests.$inferSelect & { waitStopped: boolean })[];
          reports: (typeof reports.$inferSelect)[];
          cleanups: (typeof cleanups.$inferSelect & { running: boolean })[];
        }[],
        SourceFailure
      > => {
        const now = Date.now();
        const rows = db
          .select()
          .from(sources)
          .where(
            sourceId === undefined
              ? eq(sources.repository, repository)
              : and(eq(sources.repository, repository), eq(sources.id, sourceId)),
          )
          .orderBy(asc(sources.registeredAt), asc(sources.id))
          .all();
        if (sourceId !== undefined && rows.length === 0)
          return Err({
            reason: "source_not_found",
            detail: "The source does not exist in this project.",
          });
        return Ok(
          rows.map((source) => ({
            source,
            assignments: db
              .select()
              .from(assignments)
              .where(eq(assignments.sourceId, source.id))
              .all(),
            launches: db
              .select()
              .from(launches)
              .where(eq(launches.sourceId, source.id))
              .orderBy(asc(launches.assignment), asc(launches.attempt))
              .all()
              .map((launch) => ({
                ...launch,
                abandoned: launch.state === "starting" && ownerGone(launch, now),
              })),
            pullRequests: db
              .select()
              .from(pullRequests)
              .where(eq(pullRequests.sourceId, source.id))
              .all()
              .map((pr) => ({
                ...pr,
                waitStopped:
                  pr.waitState === "waiting" &&
                  ownerGone({ ownerPid: pr.waitOwnerPid, leaseAt: pr.waitLeaseAt }, now),
              })),
            reports: db
              .select()
              .from(reports)
              .where(eq(reports.sourceId, source.id))
              .orderBy(asc(reports.assignment), asc(reports.number))
              .all(),
            cleanups: db
              .select()
              .from(cleanups)
              .where(eq(cleanups.sourceId, source.id))
              .all()
              .map((cleanup) => ({
                ...cleanup,
                // A cleanup with no owner is gone, so it is not running.
                running: !ownerGone(cleanup, now),
              })),
          })),
        );
      },
    ),
  );
}

type ControlledSource = { repository: string; checkout: string; sourceId: string };

function controlledSource(db: BunSQLiteDatabase, target: ControlledSource) {
  const controller = db
    .select()
    .from(projects)
    .where(eq(projects.repository, target.repository))
    .get();
  if (controller?.checkout !== target.checkout)
    return Err<SourceFailure>({
      reason: "controller_mismatch",
      detail: "The controlling checkout changed. Read the project again. Nothing changed.",
    });
  const source = db
    .select()
    .from(sources)
    .where(and(eq(sources.id, target.sourceId), eq(sources.repository, target.repository)))
    .get();
  return source === undefined
    ? Err<SourceFailure>({
        reason: "source_not_found",
        detail: "The source does not exist in this project. Nothing changed.",
      })
    : Ok(source);
}

/** The records that decide whether a source may end or be deleted. */
export type EndFacts = {
  source: SourceRow;
  assignments: AssignmentRow[];
  launches: { assignment: string; state: string; abandoned: boolean; paneId: string | null }[];
  cleanups: { state: string }[];
  reports: { decision: string | null; cleanupState: string | null }[];
};

function endFacts(db: BunSQLiteDatabase, source: SourceRow): EndFacts {
  const now = Date.now();
  return {
    source,
    assignments: db.select().from(assignments).where(eq(assignments.sourceId, source.id)).all(),
    launches: db
      .select()
      .from(launches)
      .where(eq(launches.sourceId, source.id))
      .all()
      .map((launch) => ({
        assignment: launch.assignment,
        state: launch.state,
        abandoned: launch.state === "starting" && ownerGone(launch, now),
        paneId: launch.paneId,
      })),
    cleanups: db
      .select({ state: cleanups.state })
      .from(cleanups)
      .where(eq(cleanups.sourceId, source.id))
      .all(),
    reports: db
      .select({ decision: reports.decision, cleanupState: reports.cleanupState })
      .from(reports)
      .where(eq(reports.sourceId, source.id))
      .all(),
  };
}

export type RetainedResource = {
  assignment: string;
  worktreePath: string | null;
  branch: string | null;
  pullRequest: string | null;
};

/**
 * The project work that ending a source leaves: each recorded worktree that still exists, and each
 * PR that has no verified merge. A cleanup that removed a worktree leaves no row for it.
 */
function retainedResources(db: BunSQLiteDatabase, sourceId: string) {
  const open = db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.sourceId, sourceId))
    .all()
    .filter((pr) => pr.mergedHead === null);
  const rows: RetainedResource[] = [];
  for (const launch of db
    .select()
    .from(launches)
    .where(eq(launches.sourceId, sourceId))
    .orderBy(asc(launches.assignment), asc(launches.attempt))
    .all()) {
    const path = launch.worktreePath;
    // Stryker disable next-line ConditionalExpression: equivalent: existsSync reports no file for a null path, so the null check only narrows the type
    if (path === null || !existsSync(path) || rows.some((row) => row.worktreePath === path))
      continue;
    rows.push({
      assignment: launch.assignment,
      worktreePath: path,
      branch: launch.branch,
      pullRequest: open.find((pr) => pr.assignment === launch.assignment)?.url ?? null,
    });
  }
  for (const pr of open)
    if (!rows.some((row) => row.pullRequest === pr.url))
      rows.push({
        assignment: pr.assignment,
        worktreePath: null,
        branch: pr.branch,
        pullRequest: pr.url,
      });
  return rows;
}

/**
 * Apply the caller's reset rule to facts read in the same immediate transaction, so a dispatch
 * that starts a worker concurrently cannot slip under the reset.
 */
export function resetSource<E extends { reason: string; detail: string }>(
  client: Database,
  target: ControlledSource,
  decide: (facts: EndFacts) => Result<{ abandon: string[] }, E>,
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) =>
      controlledSource(db, target).flatMap(
        (source): Result<{ source: SourceRow; retained: RetainedResource[] }, SourceFailure | E> =>
          decide(endFacts(db, source)).map(({ abandon }) => {
            const endedAt = new Date().toISOString();
            // An empty list matches no assignment.
            db.update(assignments)
              .set({ state: "abandoned" })
              .where(and(eq(assignments.sourceId, source.id), inArray(assignments.key, abandon)))
              .run();
            db.update(sources)
              .set({ state: "reset", endedAt })
              .where(eq(sources.id, source.id))
              .run();
            return {
              source: { ...source, state: "reset", endedAt },
              retained: retainedResources(db, source.id).filter((row) =>
                abandon.includes(row.assignment),
              ),
            };
          }),
      ),
    ),
  );
}

/**
 * Delete one source's files and records under one writer reservation when the caller's rule
 * permits it. A failed file deletion rolls the records back, so the next prune repeats it.
 */
export function pruneSource(
  client: Database,
  paths: { stateRoot: string; projects: string },
  target: ControlledSource,
  decide: (facts: EndFacts) => boolean,
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) =>
      controlledSource(db, target).flatMap((source) => {
        const facts = endFacts(db, source);
        if (!decide(facts)) return Ok(null);
        const retained = retainedResources(db, source.id);
        const removed = removeStateDirectory(
          paths.stateRoot,
          OperatorHome.sourceDirectory(paths, {
            repository: source.repository,
            sourceId: source.id,
          }),
          // Stryker disable next-line StringLiteral: equivalent: the Err below replaces this reason with its own
          "source_prune_failed",
        );
        // An Err rolls the records back, so they keep the obligation to delete the files.
        if (removed.tag === "Err")
          return Err({ reason: "source_prune_failed" as const, detail: removed.error.detail });
        return removed.map(() => {
          db.delete(reports).where(eq(reports.sourceId, source.id)).run();
          db.delete(cleanups).where(eq(cleanups.sourceId, source.id)).run();
          db.delete(pullRequests).where(eq(pullRequests.sourceId, source.id)).run();
          db.delete(launches).where(eq(launches.sourceId, source.id)).run();
          db.delete(assignments).where(eq(assignments.sourceId, source.id)).run();
          db.delete(sources).where(eq(sources.id, source.id)).run();
          return { source, retained };
        });
      }),
    ),
  );
}
