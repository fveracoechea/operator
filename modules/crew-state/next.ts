import { readAssignment } from "./assignment.ts";
import { type Capacity } from "./capacity.ts";
import {
  CLEANUP_KINDS,
  type CleanupKind,
  type CleanupState,
  cleanupRecordOf,
  heldRetention,
  readCleanup,
} from "./cleanup.ts";
import type { CrewReader } from "./database.ts";
import { everyStageSucceeded } from "./dispatch-context.ts";
import { liveOperations, readDispatchRow, unsettledOperations } from "./dispatch.ts";
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

/**
 * The actions that are standing preconditions rather than work this crew owes.
 * One is reported first and reaches the blockers a session brings to the user, and it never
 * decides whether the crew can advance: settling it starts no work, and a running Operative is
 * unaffected by it.
 */
export const STANDING_ACTIONS = ["prove_readiness"] as const satisfies NextActionName[];

export function isStandingAction(action: string): boolean {
  return STANDING_ACTIONS.some((one) => one === action);
}

/**
 * What a person has to settle before one action can run.
 * An action carries one of these or it carries nothing, so a session that holds only blocked
 * actions always has something to bring to the user.
 */
export const NEXT_BLOCKERS = [
  "readiness_blocked",
  "escalation_required",
  "direction_required",
  "approval_required",
  "cleanup_blocked",
  "cleanup_failed",
  "cleanup_uncertain",
] as const;

export type NextBlocker = (typeof NEXT_BLOCKERS)[number];

/** The waits a session may hold. Each one names what has to answer before anything moves. */
export const NEXT_WAITS = [
  "acknowledgement_pending",
  "answer_acknowledgement_pending",
  "operative_working",
  "cleanup_held",
  "input_invalidated",
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
  /** What a person must settle first, or null when this session can act alone. */
  blocker: NextBlocker | null;
  detail: string;
  command: string;
};

export type NextWait = {
  wait: NextWaitName;
  assignmentId: string;
  attemptId: string | null;
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

export type Readiness = { ready: boolean; detail: string };

/** The place one action holds in the declared order. The list is total, so no name is missing. */
function rankOf(action: NextActionName): number {
  return (NEXT_ACTIONS.indexOf(action) + 1) * 10;
}

/** One action as a reader states it. Everything it does not name is absent, not null. */
type Draft = {
  action: NextActionName;
  detail: string;
  command: string;
  assignmentId?: string;
  attemptId?: string;
  questionId?: string;
  reviewId?: string;
  revision?: number;
  blocker?: NextBlocker;
};

/**
 * Collects one reading of the crew.
 * Actions come back in the declared order, and the waits travel with them, so a caller never
 * carries the two halves of one report separately.
 */
function collector() {
  const held: Array<{ action: NextAction; order: number }> = [];
  const waiting: NextWait[] = [];

  return {
    add(draft: Draft): void {
      held.push({
        action: {
          rank: rankOf(draft.action),
          assignmentId: null,
          attemptId: null,
          questionId: null,
          reviewId: null,
          revision: null,
          blocker: null,
          ...draft,
        },
        order: held.length,
      });
    },
    wait(entry: Omit<NextWait, "attemptId" | "agentName"> & Partial<NextWait>): void {
      waiting.push({ attemptId: null, agentName: null, ...entry });
    },
    actions(): NextAction[] {
      return held
        .toSorted((left, right) => left.action.rank - right.action.rank || left.order - right.order)
        .map((one) => one.action);
    },
    waits(): NextWait[] {
      return waiting;
    },
  };
}

type Collector = ReturnType<typeof collector>;

/** The attempts of one crew, oldest first, so a report reads them in the order they started. */
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
): void {
  const dispatch = readDispatchRow(db, request.attemptId);

  if (request.unsettled.length > 0) {
    into.add({
      action: "reconcile_attempt",
      assignmentId: request.assignmentId,
      attemptId: request.attemptId,
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
      detail:
        dispatch === null
          ? "This assignment is claimed and has no Operative yet."
          : "This launch is planned and has not finished every effect.",
      command: "operator attempt dispatch",
    });
    return;
  }

  into.wait({
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
function readQuestions(db: CrewReader, unsettled: Set<string>, into: Collector): void {
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
        revision: row.revision,
        ...(triggers.length === 0 ? {} : { blocker: "escalation_required" as const }),
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
        revision: row.revision,
        detail: "The answer is recorded and has not reached the Operative.",
        command: "operator question deliver",
      });
      continue;
    }
    if (row.state === "answered") {
      continue;
    }

    into.wait({
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
    reviewId: review.id,
    revision: request.revision,
  };

  if (review.state === "blocked") {
    into.add({
      ...subject,
      action: "replace_attempt",
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
      detail: `${undisposed(findings).length} finding(s) carry no disposition.`,
      command: "operator review dispose",
    });
    return;
  }

  if (corrections(findings).length > 0 && openCycleOf(db, request.assignmentId) === null) {
    into.add({
      ...subject,
      action: "delegate_rework",
      detail: `${corrections(findings).length} accepted correction(s) wait for a fresh Operative.`,
      command: "operator work rework",
    });
    return;
  }

  if (openCycleOf(db, request.assignmentId) === null) {
    into.add({
      ...subject,
      action: "accept_assignment",
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
    const needsUser = settles.includes("user") || settles.includes("approved-write");
    into.add({
      action: recovers ? "recover_tracker" : "record_tracker",
      assignmentId,
      revision,
      ...(needsUser ? { blocker: "approval_required" as const } : {}),
      detail: `The ${step} step is ${operation?.state ?? "unrecorded"}.`,
      command: recovers ? "operator tracker recover" : "operator tracker record",
    });
  }
}

/** What settles one recorded cleanup outcome that is not done. */
const cleanupBlockers = {
  pending: null,
  blocked: "cleanup_blocked",
  failed: "cleanup_failed",
  uncertain: "cleanup_uncertain",
  done: null,
} as const satisfies Record<CleanupState, NextBlocker | null>;

/** The disposal one ended attempt still owes, and the hold that keeps its resources. */
function readCleanupOf(
  db: CrewReader,
  request: { attemptId: string; assignmentId: string; accepted: boolean },
  into: Collector,
): void {
  const dispatch = readDispatchRow(db, request.attemptId);
  if (dispatch === null) {
    return;
  }

  const hold = heldRetention(db, request.attemptId);
  if (hold !== null) {
    into.wait({
      wait: "cleanup_held",
      assignmentId: request.assignmentId,
      attemptId: request.attemptId,
      agentName: dispatch.agentName,
      detail: `A retention hold keeps these resources: ${hold.reason}.`,
    });
    return;
  }

  const recorded = new Map<CleanupKind, CleanupState>(
    CLEANUP_KINDS.flatMap((kind) => {
      const row = readCleanup(db, { attemptId: request.attemptId, kind });
      return row === null ? [] : [[kind, cleanupRecordOf(row).state]];
    }),
  );

  /**
   * One cleanup outcome the attempt still owes.
   * A recorded state that a retry cannot clear names the person who settles it, so a stuck
   * cleanup stops this work instead of being offered on every reading.
   */
  function owed(kind: CleanupKind, action: NextActionName, command: string, detail: string) {
    const state = recorded.get(kind);
    const stuck = state === undefined ? null : cleanupBlockers[state];
    into.add({
      action: stuck === null ? action : "settle_cleanup",
      assignmentId: request.assignmentId,
      attemptId: request.attemptId,
      ...(stuck === null ? {} : { blocker: stuck }),
      detail: stuck === null ? detail : `The recorded ${kind.replace("_", " ")} is ${state}.`,
      command,
    });
  }

  if (recorded.get("process_closure") !== "done") {
    owed(
      "process_closure",
      "close_process",
      "operator cleanup close",
      "This Operative handed its work over and its process is still open.",
    );
    return;
  }

  if (recorded.get("worktree_removal") === "done" || !request.accepted) {
    return;
  }

  // Removing a checkout is never this session's decision, so it names a person either way.
  const removal = recorded.get("worktree_removal");
  const stuck = removal === undefined ? null : cleanupBlockers[removal];
  into.add({
    action: stuck === null ? "remove_worktree" : "settle_cleanup",
    assignmentId: request.assignmentId,
    attemptId: request.attemptId,
    blocker: stuck ?? "approval_required",
    detail:
      stuck === null
        ? "Removing this checkout needs its own approval against the inspected inputs."
        : `The recorded worktree removal is ${removal}.`,
    command: "operator cleanup remove",
  });
}

/** The readiness verdict, reported as the action it is when this selection is not ready. */
function readReadiness(readiness: Readiness, into: Collector): void {
  if (readiness.ready) {
    return;
  }

  into.add({
    action: "prove_readiness",
    blocker: "readiness_blocked",
    detail: readiness.detail,
    command: "operator setup readiness",
  });
}

/** An empty crew, so a project with no state answers in the shape every other reading uses. */
function emptyFrontier(capacity: Capacity): Frontier {
  return {
    capacity: {
      ...capacity,
      active: { total: 0, production: 0, review: 0 },
      freeSlots: capacity.limit,
    },
    dispatchable: [],
    blocked: [],
    active: [],
    planning: [],
    accepted: [],
    questions: [],
  };
}

/**
 * What a project that holds no crew state may do next.
 * It answers in the same shape as a project that holds one, because a session reads one
 * contract and not two.
 */
export function calculateUnowned(request: { capacity: Capacity; readiness: Readiness }): CrewNext {
  const into = collector();
  readReadiness(request.readiness, into);
  into.add({
    action: "own_crew",
    detail: "This project holds no crew state, so nothing is registered yet.",
    command: "operator crew own",
  });

  const frontier = emptyFrontier(request.capacity);
  return {
    status: "reported",
    ownership: null,
    capacity: frontier.capacity,
    actions: into.actions(),
    waits: into.waits(),
    frontier,
  };
}

/**
 * Reads everything one crew may do next and writes nothing.
 * The frontier stays the only rule for what may start, so this adds no order of its own to the
 * work it offers: it reports the frontier's order and the steps the recorded state still owes.
 */
export function calculateNext(
  db: CrewReader,
  request: { capacity: Capacity; readiness: Readiness },
): CrewNext {
  const frontier = calculateFrontier(db, request.capacity);
  const ownership = currentOwnership(db);
  const into = collector();

  readReadiness(request.readiness, into);

  const held = allAttempts(db).map((attempt) => ({
    attempt,
    unsettled: unsettledOperations(liveOperations(db, attempt.id)).map((one) => one.kind),
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
      );
    }
  }

  readQuestions(db, unsettled, into);

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
        revision: record.revision,
        blocker: "direction_required",
        detail: `${record.limitKind} reached ${record.limitValue}. Only the user can direct it.`,
        command: "operator approval grant",
      });
    }

    // Work that read an invalid result waits for the corrected one, so it is reported as the
    // wait it is rather than left out of the reading.
    const invalid = paused.get(row.id);
    if (invalid !== undefined) {
      into.wait({
        wait: "input_invalidated",
        assignmentId: row.id,
        detail: `This work read a result a defect was found in: ${invalid.join(", ")}.`,
      });
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
          reviewId: review.id,
          revision: row.revision,
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
      revision: entry.revision,
      detail: "Planning work is registered so dependencies resolve, and the Operator answers it.",
      command: "operator work accept",
    });
  }

  for (const entry of frontier.dispatchable) {
    into.add({
      action: "claim_assignment",
      assignmentId: entry.assignmentId,
      revision: entry.revision,
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
    waits: into.waits(),
    frontier,
  };
}
