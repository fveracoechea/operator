import { and, asc, eq } from "drizzle-orm";
import { TrackerUpdate } from "../tracker-update/main.ts";
import type { AssignmentRow } from "./assignment.ts";
import type { CrewReader, CrewWriter } from "./database.ts";
import {
  assignments,
  trackerObservations,
  trackerOperations,
  trackerWriteAttempts,
  workSources,
} from "./schema.ts";
import { storedTrackerRef, storedTrackerTarget } from "./work-input.ts";

/** The steps the tracker contract names. A drift from that interface is a type error here. */
export type TrackerStep = Parameters<typeof TrackerUpdate.observe>[0]["step"];

/** The three steps of one tracker update, in the order the contract records them. */
export const TRACKER_STEPS = [
  "resolution",
  "completion",
  "map_amendment",
] as const satisfies readonly TrackerStep[];

export type TrackerOperationRow = typeof trackerOperations.$inferSelect;
export type TrackerWriteRow = typeof trackerWriteAttempts.$inferSelect;
export type TrackerObservationRow = typeof trackerObservations.$inferSelect;

export type TrackerTarget = { repository: string; issue: number };

/** Where one assignment's tracker updates go. It is fixed at registration, never at use. */
export type TrackerBinding = {
  provider: string;
  sourceId: string;
  repository: string;
  issue: number;
  mapIssue: number | null;
};

export type BindingLookup =
  | { status: "bound"; assignment: AssignmentRow; binding: TrackerBinding }
  | { status: "unknown-assignment"; assignmentId: string }
  | { status: "tracker-unbound"; assignmentId: string; detail: string }
  | { status: "unsupported-provider"; assignmentId: string; provider: string };

/**
 * Reads where one assignment's tracker updates belong.
 * The provider and the ticket come from the source the assignment was registered under, so a
 * later configuration change cannot redirect work that is already registered.
 */
export function readBinding(db: CrewReader, assignmentId: string): BindingLookup {
  const assignment = db.select().from(assignments).where(eq(assignments.id, assignmentId)).all()[0];
  if (assignment === undefined) {
    return { status: "unknown-assignment", assignmentId };
  }

  const source = db
    .select()
    .from(workSources)
    .where(eq(workSources.id, assignment.sourceId))
    .all()[0];
  if (source === undefined) {
    return { status: "unknown-assignment", assignmentId };
  }

  if (TrackerUpdate.capabilities({ provider: source.tracker }) === null) {
    return { status: "unsupported-provider", assignmentId, provider: source.tracker };
  }

  if (source.trackerTarget === null || assignment.trackerRef === null) {
    return {
      status: "tracker-unbound",
      assignmentId,
      detail:
        source.trackerTarget === null
          ? `Source ${source.id} was registered with no tracker target.`
          : `Assignment ${assignmentId} was registered with no ticket of its own.`,
    };
  }

  const target = storedTrackerTarget(source.trackerTarget);
  return {
    status: "bound",
    assignment,
    binding: {
      provider: source.tracker,
      sourceId: source.id,
      repository: target.repository,
      issue: storedTrackerRef(assignment.trackerRef).issue,
      mapIssue: target.mapIssue,
    },
  };
}

/** The ticket one step writes to. A map amendment needs the source's map issue. */
export function targetOf(binding: TrackerBinding, step: TrackerStep): TrackerTarget | null {
  if (step !== "map_amendment") {
    return { repository: binding.repository, issue: binding.issue };
  }

  return binding.mapIssue === null
    ? null
    : { repository: binding.repository, issue: binding.mapIssue };
}

export function readTrackerOperation(
  db: CrewReader,
  operationId: string,
): TrackerOperationRow | null {
  return (
    db.select().from(trackerOperations).where(eq(trackerOperations.id, operationId)).all()[0] ??
    null
  );
}

export function trackerOperationFor(
  db: CrewReader,
  request: { assignmentId: string; step: TrackerStep },
): TrackerOperationRow | null {
  return (
    db
      .select()
      .from(trackerOperations)
      .where(
        and(
          eq(trackerOperations.assignmentId, request.assignmentId),
          eq(trackerOperations.step, request.step),
        ),
      )
      .all()[0] ?? null
  );
}

export function trackerOperationsOf(db: CrewReader, assignmentId: string): TrackerOperationRow[] {
  return db
    .select()
    .from(trackerOperations)
    .where(eq(trackerOperations.assignmentId, assignmentId))
    .all();
}

export function writeAttemptsOf(db: CrewReader, operationId: string): TrackerWriteRow[] {
  return db
    .select()
    .from(trackerWriteAttempts)
    .where(eq(trackerWriteAttempts.operationId, operationId))
    .orderBy(asc(trackerWriteAttempts.startedAt))
    .all();
}

export function observationsOf(db: CrewReader, operationId: string): TrackerObservationRow[] {
  return db
    .select()
    .from(trackerObservations)
    .where(eq(trackerObservations.operationId, operationId))
    .orderBy(asc(trackerObservations.observedAt))
    .all();
}

/** A write that was actually sent. An intent with no send proves nothing about the tracker. */
export function sentWrites(attempts: TrackerWriteRow[]): TrackerWriteRow[] {
  return attempts.filter((one) => one.state !== "intended");
}

export function openTrackerOperation(
  db: CrewWriter,
  request: {
    operationId: string;
    assignmentId: string;
    step: TrackerStep;
    provider: string;
    target: TrackerTarget;
    expectedActor: string;
    intent: unknown;
    intentIdentity: string;
    content: string | null;
    contentIdentity: string | null;
    closeReason: string | null;
    now: string;
  },
): void {
  db.insert(trackerOperations)
    .values({
      id: request.operationId,
      assignmentId: request.assignmentId,
      step: request.step,
      provider: request.provider,
      target: JSON.stringify(request.target),
      expectedActor: request.expectedActor,
      intent: JSON.stringify(request.intent),
      intentIdentity: request.intentIdentity,
      content: request.content,
      contentIdentity: request.contentIdentity,
      closeReason: request.closeReason,
      state: "intended",
      reason: "tracker.pending",
      problems: "[]",
      resourceId: null,
      resourceUrl: null,
      revision: 1,
      createdAt: request.now,
      updatedAt: request.now,
    })
    .run();
}

export function openWriteAttempt(
  db: CrewWriter,
  request: {
    attemptId: string;
    operationId: string;
    requestId: string;
    approvalId: string | null;
    now: string;
  },
): void {
  db.insert(trackerWriteAttempts)
    .values({
      id: request.attemptId,
      operationId: request.operationId,
      requestId: request.requestId,
      approvalId: request.approvalId,
      state: "intended",
      response: null,
      startedAt: request.now,
      settledAt: null,
    })
    .run();
}

export function settleWriteAttempt(
  db: CrewWriter,
  request: {
    attemptId: string;
    operationId: string;
    state: "succeeded" | "failed" | "uncertain";
    response: unknown;
    resourceId: string | null;
    resourceUrl: string | null;
    now: string;
  },
): void {
  db.update(trackerWriteAttempts)
    .set({
      state: request.state,
      response: JSON.stringify(request.response),
      settledAt: request.now,
    })
    .where(eq(trackerWriteAttempts.id, request.attemptId))
    .run();

  // A server identifier is recorded the moment the tracker names it, so a later recovery reads
  // that exact resource rather than scanning for it.
  if (request.resourceId !== null) {
    db.update(trackerOperations)
      .set({
        resourceId: request.resourceId,
        resourceUrl: request.resourceUrl,
        updatedAt: request.now,
      })
      .where(eq(trackerOperations.id, request.operationId))
      .run();
  }
}

export function recordObservation(
  db: CrewWriter,
  request: {
    observationId: string;
    operationId: string;
    kind: string;
    observation: unknown;
    now: string;
  },
): void {
  db.insert(trackerObservations)
    .values({
      id: request.observationId,
      operationId: request.operationId,
      kind: request.kind,
      observation: JSON.stringify(request.observation),
      observedAt: request.now,
    })
    .run();
}

export function settleTrackerOperation(
  db: CrewWriter,
  request: {
    operationId: string;
    state: string;
    reason: string;
    problems: unknown;
    now: string;
  },
): number {
  const row = readTrackerOperation(db, request.operationId);
  const revision = (row?.revision ?? 0) + 1;
  db.update(trackerOperations)
    .set({
      state: request.state,
      reason: request.reason,
      problems: JSON.stringify(request.problems),
      revision,
      updatedAt: request.now,
    })
    .where(eq(trackerOperations.id, request.operationId))
    .run();
  return revision;
}
