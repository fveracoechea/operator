import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import type { drizzle } from "drizzle-orm/bun-sqlite";
import { Err, Ok, type Result } from "unthrown";
import { checkHistory, transaction } from "./database.ts";
import { ownerGone } from "./leases.ts";
import { assignments, launches, projects, reports, sources } from "./schema.ts";
import type { StateFailure } from "./failures.ts";

export type ReportRow = typeof reports.$inferSelect;
type LaunchRow = typeof launches.$inferSelect;

/** A worker is found by its recorded pane. A SuperAgent names the assignment from its checkout. */
export type ReportTarget =
  | { by: "pane"; socket: string; paneId: string }
  | { by: "key"; repository: string; checkout: string; sourceId: string; assignment: string };

export type ReportFacts = {
  source: typeof sources.$inferSelect;
  assignment: typeof assignments.$inferSelect;
  assignments: (typeof assignments.$inferSelect)[];
  launch: (LaunchRow & { abandoned: boolean }) | null;
  reports: ReportRow[];
};

export type ReportChange = {
  assignmentState?: string;
  source?: { state: string; endedAt: string | null };
  finishLaunch?: string;
  insert?: ReportRow;
  update?: Partial<Omit<ReportRow, "sourceId" | "assignment" | "number">> & { number: number };
};

type Db = ReturnType<typeof drizzle>;
type TargetFailure = StateFailure | { reason: string; detail: string };

function locate(db: Db, target: ReportTarget) {
  if (target.by === "pane") {
    const launch = db
      .select()
      .from(launches)
      .where(
        and(
          eq(launches.paneId, target.paneId),
          eq(launches.herdrSocket, target.socket),
          inArray(launches.state, ["starting", "running"]),
        ),
      )
      .get();
    return launch === undefined
      ? Err<TargetFailure>({
          reason: "worker_launch_not_found",
          detail:
            "This pane holds no running WorkerAgent launch. Run the command in the pane that Operator dispatched for the assignment. Nothing changed.",
        })
      : Ok({ sourceId: launch.sourceId, assignment: launch.assignment });
  }
  const controller = db
    .select()
    .from(projects)
    .where(eq(projects.repository, target.repository))
    .get();
  if (controller?.checkout !== target.checkout)
    return Err<TargetFailure>({
      reason: "controller_mismatch",
      detail: "The controlling checkout changed. Read the project again. Nothing changed.",
    });
  const source = db
    .select()
    .from(sources)
    .where(and(eq(sources.id, target.sourceId), eq(sources.repository, target.repository)))
    .get();
  return source === undefined
    ? Err<TargetFailure>({
        reason: "source_not_found",
        detail: "The source does not exist in this project. Nothing changed.",
      })
    : Ok({ sourceId: source.id, assignment: target.assignment });
}

function readFacts(db: Db, target: ReportTarget) {
  return locate(db, target).flatMap(
    ({ sourceId, assignment: key }): Result<ReportFacts, TargetFailure> => {
      const source = db.select().from(sources).where(eq(sources.id, sourceId)).get();
      const rows = db.select().from(assignments).where(eq(assignments.sourceId, sourceId)).all();
      const assignment = rows.find((row) => row.key === key);
      // Stryker disable next-line ConditionalExpression: equivalent: the source id comes from a located source or from a launch whose foreign key names one
      if (source === undefined || assignment === undefined)
        return Err({
          reason: "assignment_not_found",
          detail: `Assignment ${key} does not exist in this source. Nothing changed.`,
        });
      const latest = db
        .select()
        .from(launches)
        .where(and(eq(launches.sourceId, sourceId), eq(launches.assignment, key)))
        .orderBy(desc(launches.attempt))
        .get();
      return Ok({
        source,
        assignment,
        assignments: rows,
        launch:
          latest === undefined
            ? null
            : {
                ...latest,
                abandoned: latest.state === "starting" && ownerGone(latest, Date.now()),
              },
        reports: db
          .select()
          .from(reports)
          .where(and(eq(reports.sourceId, sourceId), eq(reports.assignment, key)))
          .orderBy(asc(reports.number))
          .all(),
      });
    },
  );
}

/** Read the facts that a report command decides from, without a write transaction. */
export function readReport(client: Database, target: ReportTarget) {
  return transaction(client, false, () =>
    checkHistory(client).flatMap((db) => readFacts(db, target)),
  );
}

/**
 * Read the assignment's facts, ask the caller's rule for a change, and apply it in one
 * immediate transaction, so a concurrent submission or decision cannot apply twice.
 */
export function changeReport<E extends { reason: string; detail: string }>(
  client: Database,
  target: ReportTarget,
  decide: (facts: ReportFacts) => Result<ReportChange, E>,
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) =>
      readFacts(db, target).flatMap(
        (facts): Result<{ facts: ReportFacts; change: ReportChange }, TargetFailure | E> =>
          decide(facts).map((change) => {
            apply(db, facts, change);
            return { facts, change };
          }),
      ),
    ),
  );
}

function apply(db: Db, facts: ReportFacts, change: ReportChange) {
  const { sourceId, key } = facts.assignment;
  const now = new Date().toISOString();
  if (change.insert) db.insert(reports).values(change.insert).run();
  if (change.update) {
    const { number, ...fields } = change.update;
    db.update(reports)
      .set(fields)
      .where(
        and(
          eq(reports.sourceId, sourceId),
          eq(reports.assignment, key),
          eq(reports.number, number),
        ),
      )
      .run();
  }
  if (change.assignmentState !== undefined)
    db.update(assignments)
      .set({ state: change.assignmentState })
      .where(and(eq(assignments.sourceId, sourceId), eq(assignments.key, key)))
      .run();
  if (change.source !== undefined)
    db.update(sources).set(change.source).where(eq(sources.id, sourceId)).run();
  // An accepted report ends its running launch, so the later pane close is not an interruption.
  // Stryker disable next-line ConditionalExpression: equivalent: an absent launch id matches no launch row
  if (change.finishLaunch !== undefined)
    db.update(launches)
      .set({ state: "finished", endedAt: now })
      .where(and(eq(launches.id, change.finishLaunch), eq(launches.state, "running")))
      .run();
}
