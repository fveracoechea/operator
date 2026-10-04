import { eq } from "drizzle-orm";
import type { CrewReader } from "./database.ts";
import type { Capacity } from "./capacity.ts";
import { readAssignment } from "./assignment.ts";
import {
  Assignment,
  type FrontierBlocker,
  type Placement,
  type WritePathHolder,
} from "./assignment-machine.ts";
import { type DirectionRequestRow, openDirectionsOf, readDirection } from "./direction.ts";
import { storedLimitKind } from "./rework.ts";
import { openPauses } from "./invalidate.ts";
import type { EscalationTrigger } from "./question-input.ts";
import { blockingQuestions, questionReportOf, triggersOf } from "./questions.ts";
import { reviewOfSubmission } from "./review.ts";
import { assignmentDependencies, assignments, attempts, workSources } from "./schema.ts";
import { latestSubmission } from "./submission.ts";
import { isReview } from "./work-input.ts";
import { writePathHolders, writePathsReader } from "./write-path-grants.ts";
import { overlappingPaths, overlapsCommand } from "./write-paths.ts";
import { pendingCommitsOf } from "./take-out.ts";

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

export type { FrontierBlocker, WritePathHolder };

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

type Blocked = FrontierEntry & { blockers: FrontierBlocker[] };

/** The settled lists the frontier files an assignment in before any dispatch rule reads it. */
type Filed = Record<Exclude<Placement, "active" | "open">, FrontierEntry[]> & {
  blocked: Blocked[];
};

/** The open questions every reading of the frontier names, each with the work it holds. */
function waitingQuestions(db: CrewReader): WaitingQuestion[] {
  return blockingQuestions(db)
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
}

/**
 * The write path holds of one reading. `started` work holds from its first claim, and `offered`
 * work holds once this reading offers it, so the next entry in priority order sees it.
 */
function writePathHolds(db: CrewReader, rows: Array<typeof assignments.$inferSelect>) {
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

  return {
    holdersOf(one: FrontierEntry): WritePathHolder[] {
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
    },
    offer(one: FrontierEntry): void {
      held.push({
        assignmentId: one.assignmentId,
        sourceId: one.sourceId,
        sourceKey: one.sourceKey,
        hold: "offered",
      });
    },
  };
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
  const holds = writePathHolds(db, rows);

  const paused = openPauses(db);
  const takeOutPending = new Map(
    [...sourceOrder.keys()].map((sourceId) => [sourceId, pendingCommitsOf(db, sourceId)]),
  );
  const entries = rows.map(entry).toSorted(byPriority);
  const activeEntries = entries.flatMap((one) => {
    const attempt = attemptByAssignment.get(one.assignmentId);
    return attempt === undefined ? [] : [{ ...one, attemptId: attempt.id }];
  });

  const activeReview = activeEntries.filter((one) => isReview(one.kind)).length;
  const activeProduction = activeEntries.length - activeReview;

  const freeSlots = Math.max(0, capacity.limit - activeProduction - activeReview);
  const slots = { openSlots: freeSlots, heldProduction: activeProduction };

  const dispatchable: FrontierEntry[] = [];
  const filed: Filed = { accepted: [], withdrawn: [], planning: [], blocked: [] };

  for (const one of entries) {
    const placed = Assignment.place({
      row: one,
      invalidated: paused.get(one.assignmentId),
      active: attemptByAssignment.has(one.assignmentId),
    });
    if (Array.isArray(placed)) {
      filed.blocked.push({ ...one, blockers: placed });
      continue;
    }
    if (placed !== "open") {
      if (placed !== "active") filed[placed].push(one);
      continue;
    }

    const unstartedProduction = one.kind === "production" && !started.has(one.assignmentId);
    const blockers = Assignment.blockerOf({
      row: one,
      undirected: undirected(db, one.assignmentId).map((request) => ({
        id: request.id,
        limitKind: storedLimitKind(request.limitKind),
      })),
      reviewAssignmentId: reviewByProducer(db, one.assignmentId),
      takeOut: takeOutPending.get(one.sourceId) ?? [],
      unmet: unmetDependencies(db, one.assignmentId),
      holders: unstartedProduction
        ? { holders: holds.holdersOf(one), command: overlapsCommand(one.sourceId) }
        : null,
      capacity: { ...slots, limit: capacity.limit, productionLimit: capacity.productionLimit },
    });
    if (blockers !== null) {
      filed.blocked.push({ ...one, blockers });
      continue;
    }

    dispatchable.push(one);
    slots.openSlots -= 1;
    slots.heldProduction += isReview(one.kind) ? 0 : 1;
    if (unstartedProduction) {
      holds.offer(one);
    }
  }

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
    blocked: filed.blocked,
    active: activeEntries,
    planning: filed.planning,
    accepted: filed.accepted,
    withdrawn: filed.withdrawn,
    questions: waitingQuestions(db),
  };
}
