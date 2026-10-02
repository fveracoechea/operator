import { eq } from "drizzle-orm";
import type { CrewReader } from "./database.ts";
import type { Capacity } from "./capacity.ts";
import { readAssignment } from "./assignment.ts";
import { type DirectionRequestRow, openDirectionsOf, readDirection } from "./direction.ts";
import { type LimitKind, storedLimitKind } from "./rework.ts";
import { openPauses } from "./invalidate.ts";
import type { EscalationTrigger } from "./question-input.ts";
import { blockingQuestions, questionReportOf, triggersOf } from "./questions.ts";
import { reviewOfSubmission } from "./review.ts";
import { assignmentDependencies, assignments, attempts, workSources } from "./schema.ts";
import { latestSubmission } from "./submission.ts";
import { isExecutable, isReview } from "./work-input.ts";
import { writePathHolders, writePathsReader } from "./write-path-grants.ts";
import { overlappingPaths, overlapsCommand } from "./write-paths.ts";

export type FrontierEntry = {
  assignmentId: string;
  sourceId: string;
  sourceKey: string;
  sourceKind: string;
  sourceOrder: number;
  title: string;
  kind: string;
  orderIndex: number;
  revision: number;
  state: string;
};

export type FrontierBlocker =
  | { reason: "dependency_pending"; dependencies: Array<{ assignmentId: string; state: string }> }
  | { reason: "review_pending"; reviewAssignmentId: string | null }
  | { reason: "direction_required"; directionRequestId: string; limitKind: LimitKind }
  | { reason: "input_invalidated"; invalidated: string[] }
  | { reason: "write_paths_overlap"; holders: WritePathHolder[]; command: string }
  | { reason: "review_capacity_reserved"; productionLimit: number }
  | { reason: "crew_at_capacity"; limit: number };

/**
 * One assignment whose held write paths overlap the paths of a withheld one. `started` work
 * holds from its first claim, and `offered` work holds inside the one reading that offered it.
 * The Operator reads this, so it gives the number of overlapping pairs of paths and the blocker names the
 * command that lists them.
 */
export type WritePathHolder = {
  assignmentId: string;
  sourceKey: string;
  hold: "started" | "offered";
  pathPairCount: number;
};

type WritePathHold = Omit<WritePathHolder, "pathPairCount"> & { sourceId: string };

/** One open question and the work it holds. Every other assignment keeps moving. */
export type WaitingQuestion = {
  questionId: string;
  assignmentId: string;
  attemptId: string;
  revision: number;
  state: string;
  question: string;
  escalationTriggers: EscalationTrigger[];
  affectedScope: string[];
  independentWork: string[];
};

export type Frontier = {
  capacity: Capacity & {
    active: { total: number; production: number; review: number };
    freeSlots: number;
  };
  dispatchable: FrontierEntry[];
  blocked: Array<FrontierEntry & { blockers: FrontierBlocker[] }>;
  active: Array<FrontierEntry & { attemptId: string }>;
  planning: FrontierEntry[];
  accepted: FrontierEntry[];
  // Terminal work that a person removed from its parent. It never satisfies a dependency.
  withdrawn: FrontierEntry[];
  questions: WaitingQuestion[];
};

/** Review outranks production; inside one kind the recorded source order decides. */
function byPriority(left: FrontierEntry, right: FrontierEntry): number {
  const rank = (entry: FrontierEntry) => (isReview(entry.kind) ? 0 : 1);
  return (
    rank(left) - rank(right) ||
    left.sourceOrder - right.sourceOrder ||
    left.orderIndex - right.orderIndex ||
    left.assignmentId.localeCompare(right.assignmentId)
  );
}

export function unmetDependencies(
  db: CrewReader,
  id: string,
): Array<{ assignmentId: string; state: string }> {
  const edges = db
    .select()
    .from(assignmentDependencies)
    .where(eq(assignmentDependencies.assignmentId, id))
    .all();

  return (
    edges
      .map((edge) => {
        const row = readAssignment(db, edge.dependsOnId);
        return { assignmentId: edge.dependsOnId, state: row?.state ?? "unknown" };
      })
      // Only accepted work satisfies a dependency. A withdrawn result never reaches the base.
      .filter((dependency) => dependency.state !== "accepted")
      .toSorted((left, right) => left.assignmentId.localeCompare(right.assignmentId))
  );
}

/** The review assignment that holds the latest submission of one producer assignment. */
function reviewByProducer(db: CrewReader, assignmentId: string): string | null {
  const latest = latestSubmission(db, assignmentId);
  return latest === null ? null : (reviewOfSubmission(db, latest.id)?.assignmentId ?? null);
}

export function activeAttempt(db: CrewReader, id: string) {
  return (
    db
      .select()
      .from(attempts)
      .where(eq(attempts.assignmentId, id))
      .all()
      .find((attempt) => attempt.state === "active") ?? null
  );
}

/** The open direction requests of one assignment that no approval of the user answers yet. */
export function undirected(db: CrewReader, assignmentId: string): DirectionRequestRow[] {
  return openDirectionsOf(db, assignmentId).filter(
    (request) =>
      readDirection(db, {
        assignmentId,
        limitKind: storedLimitKind(request.limitKind),
      }).status !== "directed",
  );
}

/** Reads every ordering, dependency, and capacity input and writes nothing. */
export function calculateFrontier(db: CrewReader, capacity: Capacity): Frontier {
  const sourceOrder = new Map(
    db
      .select()
      .from(workSources)
      .all()
      .map((source) => [source.id, { order: source.orderIndex, kind: source.kind }]),
  );

  const rows = db.select().from(assignments).all();
  const recordedAttempts = db.select().from(attempts).all();
  const liveAttempts = recordedAttempts.filter((attempt) => attempt.state === "active");
  const attemptByAssignment = new Map(liveAttempts.map((one) => [one.assignmentId, one]));

  function entry(row: (typeof rows)[number]): FrontierEntry {
    const source = sourceOrder.get(row.sourceId);
    return {
      assignmentId: row.id,
      sourceId: row.sourceId,
      sourceKey: row.sourceKey,
      sourceKind: source?.kind ?? "unknown",
      sourceOrder: source?.order ?? Number.MAX_SAFE_INTEGER,
      title: row.title,
      kind: row.kind,
      orderIndex: row.orderIndex,
      revision: row.revision,
      state: row.state,
    };
  }

  // The hold rule reads no list of states. It lives with the grants, which read the same rule.
  const started = new Set(recordedAttempts.map((attempt) => attempt.assignmentId));
  const holds = writePathHolders(db);
  // The effective write paths: a grant widens what an assignment holds and what it asks for.
  const effectiveOf = writePathsReader(db);
  const writePathsOf = new Map(rows.map((row) => [row.id, effectiveOf(row)]));
  const held: WritePathHold[] = rows.filter(holds).map((row) => ({
    assignmentId: row.id,
    sourceId: row.sourceId,
    sourceKey: row.sourceKey,
    hold: "started",
  }));

  function holdersOf(one: FrontierEntry): WritePathHolder[] {
    const paths = writePathsOf.get(one.assignmentId) ?? [];
    return (
      held
        .filter((holder) => holder.sourceId === one.sourceId)
        .map((holder) => ({
          assignmentId: holder.assignmentId,
          sourceKey: holder.sourceKey,
          hold: holder.hold,
          pathPairCount: overlappingPaths(paths, writePathsOf.get(holder.assignmentId) ?? [])
            .length,
        }))
        .filter((holder) => holder.pathPairCount > 0)
        // A code-unit order, so the order never depends on the locale of the machine.
        .toSorted((left, right) => (left.assignmentId < right.assignmentId ? -1 : 1))
    );
  }

  const paused = openPauses(db);
  const entries = rows.map(entry).toSorted(byPriority);
  const activeEntries = entries.flatMap((one) => {
    const attempt = attemptByAssignment.get(one.assignmentId);
    return attempt === undefined ? [] : [{ ...one, attemptId: attempt.id }];
  });

  const activeReview = activeEntries.filter((one) => isReview(one.kind)).length;
  const activeProduction = activeEntries.length - activeReview;

  const freeSlots = Math.max(0, capacity.limit - activeProduction - activeReview);
  let openSlots = freeSlots;
  let heldProduction = activeProduction;

  const dispatchable: FrontierEntry[] = [];
  const blocked: Array<FrontierEntry & { blockers: FrontierBlocker[] }> = [];
  const planning: FrontierEntry[] = [];
  const accepted: FrontierEntry[] = [];
  const withdrawn: FrontierEntry[] = [];

  for (const one of entries) {
    if (one.state === "accepted") {
      accepted.push(one);
      continue;
    }
    if (one.state === "withdrawn") {
      withdrawn.push(one);
      continue;
    }
    // Work that read an invalidated result waits for the corrected one, whatever kind it is
    // and whatever its former writer is still doing.
    const invalid = paused.get(one.assignmentId);
    if (invalid !== undefined) {
      blocked.push({ ...one, blockers: [{ reason: "input_invalidated", invalidated: invalid }] });
      continue;
    }

    if (!isExecutable(one.kind)) {
      planning.push(one);
      continue;
    }
    if (attemptByAssignment.has(one.assignmentId)) {
      continue;
    }

    // A reached limit waits on the user, whatever state the assignment stopped in. A direction
    // the user already gave waits on nobody, and the action it permits spends it.
    const waiting = undirected(db, one.assignmentId);
    if (waiting.length > 0) {
      blocked.push({
        ...one,
        blockers: waiting.map((request) => ({
          reason: "direction_required" as const,
          directionRequestId: request.id,
          limitKind: storedLimitKind(request.limitKind),
        })),
      });
      continue;
    }

    // A submitted result waits for its own review, not for a second attempt at the same work.
    if (one.state === "awaiting-review") {
      blocked.push({
        ...one,
        blockers: [
          { reason: "review_pending", reviewAssignmentId: reviewByProducer(db, one.assignmentId) },
        ],
      });
      continue;
    }

    const unmet = unmetDependencies(db, one.assignmentId);
    if (unmet.length > 0) {
      blocked.push({ ...one, blockers: [{ reason: "dependency_pending", dependencies: unmet }] });
      continue;
    }

    // Work that has started keeps the base of its dispatch, so only new work waits for a holder.
    // An entry held here takes no slot, so the next entry in priority order can still start.
    const unstartedProduction = one.kind === "production" && !started.has(one.assignmentId);
    if (unstartedProduction) {
      const holders = holdersOf(one);
      if (holders.length > 0) {
        blocked.push({
          ...one,
          blockers: [
            { reason: "write_paths_overlap", holders, command: overlapsCommand(one.sourceId) },
          ],
        });
        continue;
      }
    }

    if (openSlots === 0) {
      blocked.push({ ...one, blockers: [{ reason: "crew_at_capacity", limit: capacity.limit }] });
      continue;
    }

    if (!isReview(one.kind) && heldProduction >= capacity.productionLimit) {
      blocked.push({
        ...one,
        blockers: [
          { reason: "review_capacity_reserved", productionLimit: capacity.productionLimit },
        ],
      });
      continue;
    }

    dispatchable.push(one);
    openSlots -= 1;
    if (!isReview(one.kind)) {
      heldProduction += 1;
    }
    if (unstartedProduction) {
      held.push({
        assignmentId: one.assignmentId,
        sourceId: one.sourceId,
        sourceKey: one.sourceKey,
        hold: "offered",
      });
    }
  }

  const waiting = blockingQuestions(db)
    .map((row) => {
      const report = questionReportOf(row);
      return {
        questionId: row.id,
        assignmentId: row.assignmentId,
        attemptId: row.attemptId,
        revision: row.revision,
        state: row.state,
        question: report.question,
        escalationTriggers: triggersOf(row),
        affectedScope: report.affectedScope,
        independentWork: report.independentWork,
      };
    })
    .toSorted((left, right) => left.questionId.localeCompare(right.questionId));

  return {
    capacity: {
      ...capacity,
      active: {
        total: activeProduction + activeReview,
        production: activeProduction,
        review: activeReview,
      },
      freeSlots,
    },
    dispatchable,
    blocked,
    active: activeEntries,
    planning,
    accepted,
    withdrawn,
    questions: waiting,
  };
}
