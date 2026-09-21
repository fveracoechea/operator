import { eq } from "drizzle-orm";
import type { CrewReader } from "./database.ts";
import type { Capacity } from "./capacity.ts";
import { blockingQuestions, reportOf, triggersOf } from "./questions.ts";
import { assignmentDependencies, assignments, attempts, workSources } from "./schema.ts";
import { isExecutable, isReview } from "./work-input.ts";

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
  | { reason: "review_capacity_reserved"; productionLimit: number }
  | { reason: "crew_at_capacity"; limit: number };

/** One open question and the work it holds. Every other assignment keeps moving. */
export type WaitingQuestion = {
  questionId: string;
  assignmentId: string;
  attemptId: string;
  revision: number;
  state: string;
  question: string;
  escalationTriggers: string[];
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

export function readAssignment(db: CrewReader, id: string) {
  return db.select().from(assignments).where(eq(assignments.id, id)).all()[0] ?? null;
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

  return edges
    .map((edge) => {
      const row = readAssignment(db, edge.dependsOnId);
      return { assignmentId: edge.dependsOnId, state: row?.state ?? "unknown" };
    })
    .filter((dependency) => dependency.state !== "accepted")
    .toSorted((left, right) => left.assignmentId.localeCompare(right.assignmentId));
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
  const liveAttempts = db
    .select()
    .from(attempts)
    .all()
    .filter((attempt) => attempt.state === "active");
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

  for (const one of entries) {
    if (one.state === "accepted") {
      accepted.push(one);
      continue;
    }
    if (!isExecutable(one.kind)) {
      planning.push(one);
      continue;
    }
    if (attemptByAssignment.has(one.assignmentId)) {
      continue;
    }

    const unmet = unmetDependencies(db, one.assignmentId);
    if (unmet.length > 0) {
      blocked.push({ ...one, blockers: [{ reason: "dependency_pending", dependencies: unmet }] });
      continue;
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
  }

  const waiting = blockingQuestions(db)
    .map((row) => {
      const report = reportOf(row);
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
    questions: waiting,
  };
}
