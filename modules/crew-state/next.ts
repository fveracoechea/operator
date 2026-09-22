import { readAssignment } from "./assignment.ts";
import { type Capacity } from "./capacity.ts";
import {
  CLEANUP_KINDS,
  type CleanupKind,
  heldRetention,
  readCleanup,
  type RetentionHoldRow,
} from "./cleanup.ts";
import type { CrewReader } from "./database.ts";
import { everyStageSucceeded } from "./dispatch-context.ts";
import { liveOperations, readDispatchRow } from "./dispatch.ts";
import { directionRecordOf, openDirectionsOf } from "./direction.ts";
import { calculateFrontier, type Frontier, unmetDependencies } from "./frontier.ts";
import { openPauses } from "./invalidate.ts";
import { currentOwnership } from "./ownership.ts";
import { blockingQuestions, triggersOf } from "./questions.ts";
import {
  corrections,
  findingsOf,
  reviewOfAssignment,
  reviewOfSubmission,
  undisposed,
} from "./review.ts";
import { openCycleOf } from "./rework.ts";
import { assignments, attempts } from "./schema.ts";
import { latestSubmission } from "./submission.ts";
import { readBinding, TRACKER_STEPS, targetOf, trackerOperationsOf } from "./tracker.ts";
import { trackerStepActions } from "./tracker-show.ts";
import { isReview } from "./work-input.ts";

/**
 * Everything one crew can do next, in one order.
 * A recovery comes before a conversation, a conversation before a pipeline step, and a launch
 * last, so a session never starts new work while an unproven effect or an unanswered question
 * is still open.
 */
export const NEXT_ACTIONS = [
  "prove_readiness",
  "own_crew",
  "reconcile_attempt",
  "adopt_attempt",
  "recover_tracker",
  "settle_cleanup",
  "replace_attempt",
  "answer_question",
  "deliver_answer",
  "dispose_findings",
  "delegate_rework",
  "accept_assignment",
  "resolve_planning",
  "record_tracker",
  "close_process",
  "remove_worktree",
  "direct_limit",
  "dispatch_attempt",
  "claim_assignment",
] as const;

export type NextActionName = (typeof NEXT_ACTIONS)[number];

/** The waits a session may hold. Each one names what has to answer before anything moves. */
export const NEXT_WAITS = [
  "acknowledgement_pending",
  "answer_acknowledgement_pending",
  "operative_working",
  "cleanup_held",
] as const;

export type NextWaitName = (typeof NEXT_WAITS)[number];

export type NextAction = {
  action: NextActionName;
  rank: number;
  assignmentId: string | null;
  attemptId: string | null;
  questionId: string | null;
  reviewId: string | null;
  /** The record revision a mutation on this subject must state, when it has one. */
  revision: number | null;
  /** True when a person has to settle something before this action can run. */
  needsUser: boolean;
  detail: string;
  command: string;
};

export type NextWait = {
  wait: NextWaitName;
  assignmentId: string;
  attemptId: string;
  /** The Herdr agent a bounded wait watches, when this wait has one. */
  agentName: string | null;
  detail: string;
};

export type CrewNext = {
  status: "reported";
  ownership: { ownerLabel: string; acquiredAt: string; revision: number } | null;
  capacity: Frontier["capacity"];
  actions: NextAction[];
  waits: NextWait[];
  frontier: Frontier;
};

const rankOf = new Map<NextActionName, number>(
  NEXT_ACTIONS.map((action, index) => [action, (index + 1) * 10]),
);

/** The place one action holds in the declared order. One rendering, so a caller never guesses. */
export function nextActionRank(action: NextActionName): number {
  return rankOf.get(action) ?? 0;
}

type Draft = Omit<NextAction, "rank"> & { action: NextActionName };

/** Collects the actions of one reading and keeps them in the one declared order. */
function collector() {
  const held: Array<{ action: NextAction; order: number }> = [];

  return {
    add(draft: Draft): void {
      held.push({
        action: { ...draft, rank: rankOf.get(draft.action) ?? 0 },
        order: held.length,
      });
    },
    actions(): NextAction[] {
      return held
        .toSorted((left, right) => left.action.rank - right.action.rank || left.order - right.order)
        .map((one) => one.action);
    },
  };
}

type Collector = ReturnType<typeof collector>;

/** The attempts of one crew, newest last, so a report reads them in the order they started. */
function allAttempts(db: CrewReader) {
  return db
    .select()
    .from(attempts)
    .all()
    .toSorted(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id),
    );
}

/** Every effect of one attempt that recorded an intent and never proved an outcome. */
function unsettledEffects(db: CrewReader, attemptId: string): string[] {
  return liveOperations(db, attemptId)
    .filter((one) => one.state === "intended" || one.state === "uncertain")
    .map((one) => one.kind);
}

/** One active attempt: what it still owes, or what it is waiting for. */
function readActiveAttempt(
  db: CrewReader,
  request: {
    attemptId: string;
    assignmentId: string;
    ownedByCurrent: boolean;
    unsettled: string[];
  },
  into: Collector,
  waits: NextWait[],
): void {
  const dispatch = readDispatchRow(db, request.attemptId);

  if (request.unsettled.length > 0) {
    into.add({
      action: "reconcile_attempt",
      assignmentId: request.assignmentId,
      attemptId: request.attemptId,
      questionId: null,
      reviewId: null,
      revision: null,
      needsUser: false,
      detail: `${request.unsettled.join(", ")} never proved an outcome.`,
      command: "operator attempt reconcile",
    });
    return;
  }

  if (!request.ownedByCurrent) {
    into.add({
      action: "adopt_attempt",
      assignmentId: request.assignmentId,
      attemptId: request.attemptId,
      questionId: null,
      reviewId: null,
      revision: null,
      needsUser: false,
      detail: "A replaced Operator claimed this attempt, so this session cannot change it yet.",
      command: "operator attempt adopt",
    });
    return;
  }

  // A launch that has not finished every effect resumes at the first one that is unfinished,
  // which is the same command that started it.
  if (dispatch === null || !everyStageSucceeded(liveOperations(db, request.attemptId))) {
    into.add({
      action: "dispatch_attempt",
      assignmentId: request.assignmentId,
      attemptId: request.attemptId,
      questionId: null,
      reviewId: null,
      revision: null,
      needsUser: false,
      detail:
        dispatch === null
          ? "This assignment is claimed and has no Operative yet."
          : "This launch is planned and has not finished every effect.",
      command: "operator attempt dispatch",
    });
    return;
  }

  waits.push({
    wait: dispatch.acknowledgedAt === null ? "acknowledgement_pending" : "operative_working",
    assignmentId: request.assignmentId,
    attemptId: request.attemptId,
    agentName: dispatch.agentName,
    detail:
      dispatch.acknowledgedAt === null
        ? "Herdr accepted the submission. The Operative has not acknowledged the brief."
        : "The Operative acknowledged its brief and is working.",
  });
}

/** Every question that still holds an Operative, and what carries it forward. */
function readQuestions(
  db: CrewReader,
  unsettled: Set<string>,
  into: Collector,
  waits: NextWait[],
): void {
  for (const row of blockingQuestions(db).toSorted((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const triggers = triggersOf(row);
    if (row.state === "open") {
      into.add({
        action: "answer_question",
        assignmentId: row.assignmentId,
        attemptId: row.attemptId,
        questionId: row.id,
        reviewId: null,
        revision: row.revision,
        needsUser: triggers.length > 0,
        detail:
          triggers.length > 0
            ? `This question names ${triggers.join(", ")}, so only a person may settle it.`
            : "This question is inside delegated authority.",
        command: "operator question answer",
      });
      continue;
    }

    // A delivery that never proved an outcome is reconciled, never submitted a second time.
    if (row.state === "answered" && !unsettled.has(row.attemptId)) {
      into.add({
        action: "deliver_answer",
        assignmentId: row.assignmentId,
        attemptId: row.attemptId,
        questionId: row.id,
        reviewId: null,
        revision: row.revision,
        needsUser: false,
        detail: "The answer is recorded and has not reached the Operative.",
        command: "operator question deliver",
      });
      continue;
    }
    if (row.state === "answered") {
      continue;
    }

    waits.push({
      wait: "answer_acknowledgement_pending",
      assignmentId: row.assignmentId,
      attemptId: row.attemptId,
      agentName: readDispatchRow(db, row.attemptId)?.agentName ?? null,
      detail: "The answer was submitted. The Operative has not acknowledged it.",
    });
  }
}

/** The review of one submitted result, and the step it now owes. */
function readReview(
  db: CrewReader,
  request: { assignmentId: string; revision: number },
  into: Collector,
): void {
  const submission = latestSubmission(db, request.assignmentId);
  const review = submission === null ? null : reviewOfSubmission(db, submission.id);
  if (review === null) {
    return;
  }

  const subject = {
    assignmentId: request.assignmentId,
    attemptId: null,
    questionId: null,
    reviewId: review.id,
    revision: request.revision,
  };

  if (review.state === "blocked") {
    into.add({
      ...subject,
      action: "replace_attempt",
      needsUser: false,
      detail: "The review stopped before it reported. Correct what it names, then replace it.",
      command: "operator attempt replace",
    });
    return;
  }
  if (review.state !== "reported") {
    return;
  }

  const findings = findingsOf(db, review.id);
  if (undisposed(findings).length > 0) {
    into.add({
      ...subject,
      action: "dispose_findings",
      needsUser: false,
      detail: `${undisposed(findings).length} finding(s) carry no disposition.`,
      command: "operator review dispose",
    });
    return;
  }

  if (corrections(findings).length > 0 && openCycleOf(db, request.assignmentId) === null) {
    into.add({
      ...subject,
      action: "delegate_rework",
      needsUser: false,
      detail: `${corrections(findings).length} accepted correction(s) wait for a fresh Operative.`,
      command: "operator work rework",
    });
    return;
  }

  if (openCycleOf(db, request.assignmentId) === null) {
    into.add({
      ...subject,
      action: "accept_assignment",
      needsUser: false,
      detail: "The review reported and every finding carries a disposition.",
      command: "operator work accept",
    });
  }
}

/** The tracker steps one accepted assignment still owes. */
function readTracker(
  db: CrewReader,
  assignmentId: string,
  revision: number,
  into: Collector,
): void {
  const bound = readBinding(db, assignmentId);
  if (bound.status !== "bound") {
    return;
  }

  const held = trackerOperationsOf(db, assignmentId);
  for (const step of TRACKER_STEPS) {
    const operation = held.find((one) => one.step === step) ?? null;
    const applicable = targetOf(bound.binding, step) !== null;
    const settles = trackerStepActions({ applicable, operation });
    if (settles.length === 0) {
      continue;
    }

    const recovers = settles.includes("recover");
    into.add({
      action: recovers ? "recover_tracker" : "record_tracker",
      assignmentId,
      attemptId: null,
      questionId: null,
      reviewId: null,
      revision,
      needsUser: settles.includes("user") || settles.includes("approved-write"),
      detail: `The ${step} step is ${operation?.state ?? "unrecorded"}.`,
      command: recovers ? "operator tracker recover" : "operator tracker record",
    });
  }
}

/** The disposal one ended attempt still owes, and the hold that keeps its resources. */
function readCleanupOf(
  db: CrewReader,
  request: { attemptId: string; assignmentId: string; accepted: boolean },
  into: Collector,
  waits: NextWait[],
): void {
  const dispatch = readDispatchRow(db, request.attemptId);
  if (dispatch === null) {
    return;
  }

  const hold: RetentionHoldRow | null = heldRetention(db, request.attemptId);
  if (hold !== null) {
    waits.push({
      wait: "cleanup_held",
      assignmentId: request.assignmentId,
      attemptId: request.attemptId,
      agentName: dispatch.agentName,
      detail: `A retention hold keeps these resources: ${hold.reason}.`,
    });
    return;
  }

  const recorded = new Map<CleanupKind, string>(
    CLEANUP_KINDS.flatMap((kind) => {
      const row = readCleanup(db, { attemptId: request.attemptId, kind });
      return row === null ? [] : [[kind, row.state] as [CleanupKind, string]];
    }),
  );

  const closure = recorded.get("process_closure");
  if (closure !== "done") {
    into.add({
      action: closure === undefined ? "close_process" : "settle_cleanup",
      assignmentId: request.assignmentId,
      attemptId: request.attemptId,
      questionId: null,
      reviewId: null,
      revision: null,
      needsUser: false,
      detail:
        closure === undefined
          ? "This Operative handed its work over and its process is still open."
          : `The recorded process closure is ${closure}.`,
      command: "operator cleanup close",
    });
    return;
  }

  const removal = recorded.get("worktree_removal");
  if (removal === "done" || !request.accepted) {
    return;
  }

  into.add({
    action: removal === undefined ? "remove_worktree" : "settle_cleanup",
    assignmentId: request.assignmentId,
    attemptId: request.attemptId,
    questionId: null,
    reviewId: null,
    revision: null,
    needsUser: true,
    detail:
      removal === undefined
        ? "Removing this checkout needs its own approval against the inspected inputs."
        : `The recorded worktree removal is ${removal}.`,
    command: "operator cleanup remove",
  });
}

/**
 * Reads everything one crew may do next and writes nothing.
 * The frontier stays the only rule for what may start, so this adds no order of its own to the
 * work it offers: it reports the frontier's order and the steps the recorded state still owes.
 */
export function calculateNext(
  db: CrewReader,
  request: { capacity: Capacity; readiness: { ready: boolean; detail: string } },
): CrewNext {
  const frontier = calculateFrontier(db, request.capacity);
  const ownership = currentOwnership(db);
  const into = collector();
  const waits: NextWait[] = [];

  if (!request.readiness.ready) {
    into.add({
      action: "prove_readiness",
      assignmentId: null,
      attemptId: null,
      questionId: null,
      reviewId: null,
      revision: null,
      needsUser: true,
      detail: request.readiness.detail,
      command: "operator setup readiness",
    });
  }

  const held = allAttempts(db).map((attempt) => ({
    attempt,
    unsettled: unsettledEffects(db, attempt.id),
  }));
  const unsettled = new Set(
    held.flatMap((one) => (one.unsettled.length === 0 ? [] : [one.attempt.id])),
  );

  for (const { attempt, unsettled: pending } of held) {
    const assignment = readAssignment(db, attempt.assignmentId);
    if (assignment === null) {
      continue;
    }

    if (attempt.state === "active") {
      readActiveAttempt(
        db,
        {
          attemptId: attempt.id,
          assignmentId: attempt.assignmentId,
          ownedByCurrent: ownership !== null && ownership.token === attempt.ownerToken,
          unsettled: pending,
        },
        into,
        waits,
      );
      continue;
    }

    // A replaced attempt handed its checkout and its agent name to the replacement, so the
    // disposal of those resources belongs to the attempt that holds them now.
    if (attempt.state === "submitted" || attempt.state === "accepted") {
      readCleanupOf(
        db,
        {
          attemptId: attempt.id,
          assignmentId: attempt.assignmentId,
          accepted: assignment.state === "accepted",
        },
        into,
        waits,
      );
    }
  }

  readQuestions(db, unsettled, into, waits);

  const paused = openPauses(db);
  for (const row of db
    .select()
    .from(assignments)
    .all()
    .toSorted((left, right) => left.id.localeCompare(right.id))) {
    for (const direction of openDirectionsOf(db, row.id)) {
      const record = directionRecordOf(direction);
      into.add({
        action: "direct_limit",
        assignmentId: row.id,
        attemptId: null,
        questionId: null,
        reviewId: null,
        revision: record.revision,
        needsUser: true,
        detail: `${record.limitKind} reached ${record.limitValue}. Only the user can direct it.`,
        command: "operator approval grant",
      });
    }

    if (paused.has(row.id)) {
      continue;
    }

    if (row.state === "awaiting-review") {
      readReview(db, { assignmentId: row.id, revision: row.revision }, into);
    }

    // A review assignment holds no result of its own, so it is accepted once it reported.
    if (row.state === "claimed" && isReview(row.kind)) {
      const review = reviewOfAssignment(db, row.id);
      if (review !== null && review.state === "reported") {
        into.add({
          action: "accept_assignment",
          assignmentId: row.id,
          attemptId: null,
          questionId: null,
          reviewId: review.id,
          revision: row.revision,
          needsUser: false,
          detail: "This reviewer reported both axes, so its own assignment can be accepted.",
          command: "operator work accept",
        });
      }
    }

    if (row.state === "accepted") {
      readTracker(db, row.id, row.revision, into);
    }
  }

  // Planning work is never dispatched, so the Operator resolves it once its dependencies land.
  for (const entry of frontier.planning) {
    if (paused.has(entry.assignmentId) || unmetDependencies(db, entry.assignmentId).length > 0) {
      continue;
    }

    into.add({
      action: "resolve_planning",
      assignmentId: entry.assignmentId,
      attemptId: null,
      questionId: null,
      reviewId: null,
      revision: entry.revision,
      needsUser: false,
      detail: "Planning work is registered so dependencies resolve, and the Operator answers it.",
      command: "operator work accept",
    });
  }

  for (const entry of frontier.dispatchable) {
    into.add({
      action: "claim_assignment",
      assignmentId: entry.assignmentId,
      attemptId: null,
      questionId: null,
      reviewId: null,
      revision: entry.revision,
      needsUser: false,
      detail: `${entry.kind} work the frontier offers now.`,
      command: "operator work claim",
    });
  }

  return {
    status: "reported",
    ownership:
      ownership === null
        ? null
        : {
            ownerLabel: ownership.ownerLabel,
            acquiredAt: ownership.acquiredAt,
            revision: ownership.revision,
          },
    capacity: frontier.capacity,
    actions: into.actions(),
    waits,
    frontier,
  };
}
