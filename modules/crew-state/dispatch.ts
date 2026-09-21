import { and, eq, ne } from "drizzle-orm";
import type { CrewReader, CrewWriter } from "./database.ts";
import { currentOwnership } from "./ownership.ts";
import { assignments, attemptDispatch, attempts, externalOperations } from "./schema.ts";

/** The external effects one launch performs, in the order a dispatch performs them. */
export const DISPATCH_STAGES = [
  "worktree_create",
  "input_preparation",
  "agent_start",
  "prompt_delivery",
] as const;

export type DispatchStage = (typeof DISPATCH_STAGES)[number];

export type OperationState = "intended" | "succeeded" | "failed" | "uncertain";

export type AttemptRow = typeof attempts.$inferSelect;
export type AssignmentRow = typeof assignments.$inferSelect;
export type DispatchRow = typeof attemptDispatch.$inferSelect;
export type OperationRow = typeof externalOperations.$inferSelect;

export type AttemptContext = {
  attempt: AttemptRow;
  assignment: AssignmentRow;
  dispatch: DispatchRow | null;
  operations: OperationRow[];
  // True while the Operator that claimed this attempt still owns the crew.
  current: boolean;
};

export type AttemptLookup =
  | { status: "ok"; context: AttemptContext }
  | { status: "unknown-attempt"; attemptId: string }
  | { status: "attempt-ended"; attemptId: string; state: string }
  | { status: "attempt-not-current"; attemptId: string };

export function readDispatchRow(db: CrewReader, attemptId: string): DispatchRow | null {
  return (
    db.select().from(attemptDispatch).where(eq(attemptDispatch.attemptId, attemptId)).all()[0] ??
    null
  );
}

/** The operations that still describe this attempt. A failed one is history, never a blocker. */
export function liveOperations(db: CrewReader, attemptId: string): OperationRow[] {
  return db
    .select()
    .from(externalOperations)
    .where(and(eq(externalOperations.attemptId, attemptId), ne(externalOperations.state, "failed")))
    .all();
}

export function operationFor(operations: OperationRow[], kind: DispatchStage): OperationRow | null {
  return operations.find((one) => one.kind === kind) ?? null;
}

/**
 * Reads one attempt with everything a change to it needs, and whether it is still the current
 * writer. An attempt that a replaced Operator claimed stays readable and stays blocked until
 * the new owner adopts it.
 */
export function lookupAttempt(db: CrewReader, attemptId: string): AttemptLookup {
  const attempt = db.select().from(attempts).where(eq(attempts.id, attemptId)).all()[0];
  if (attempt === undefined) {
    return { status: "unknown-attempt", attemptId };
  }
  if (attempt.state !== "active") {
    return { status: "attempt-ended", attemptId: attempt.id, state: attempt.state };
  }

  const assignment = db
    .select()
    .from(assignments)
    .where(eq(assignments.id, attempt.assignmentId))
    .all()[0];
  if (assignment === undefined) {
    return { status: "unknown-attempt", attemptId: attempt.id };
  }

  return {
    status: "ok",
    context: {
      attempt,
      assignment,
      dispatch: readDispatchRow(db, attempt.id),
      operations: liveOperations(db, attempt.id),
      current: currentOwnership(db)?.token === attempt.ownerToken,
    },
  };
}

export function recordPlan(
  db: CrewWriter,
  request: {
    attemptId: string;
    assignmentId: string;
    baseCommit: string;
    branch: string;
    worktreePath: string;
    snapshot: unknown;
    snapshotIdentity: string;
    briefIdentity: string;
    promptIdentity: string;
    agentName: string;
    agentKind: string;
    agentHost: string;
    workspaceId: string | null;
    now: string;
  },
): void {
  db.insert(attemptDispatch)
    .values({
      attemptId: request.attemptId,
      assignmentId: request.assignmentId,
      baseCommit: request.baseCommit,
      branch: request.branch,
      worktreePath: request.worktreePath,
      snapshot: JSON.stringify(request.snapshot),
      snapshotIdentity: request.snapshotIdentity,
      briefIdentity: request.briefIdentity,
      promptIdentity: request.promptIdentity,
      agentName: request.agentName,
      agentKind: request.agentKind,
      agentHost: request.agentHost,
      workspaceId: request.workspaceId,
      paneId: null,
      acknowledgedAt: null,
      inspection: null,
      inspectionIdentity: null,
      createdAt: request.now,
      updatedAt: request.now,
    })
    .run();
}

export function openOperation(
  db: CrewWriter,
  request: {
    operationId: string;
    attemptId: string;
    kind: DispatchStage;
    requestId: string;
    intent: unknown;
    now: string;
  },
): void {
  db.insert(externalOperations)
    .values({
      id: request.operationId,
      attemptId: request.attemptId,
      kind: request.kind,
      requestId: request.requestId,
      intent: JSON.stringify(request.intent),
      state: "intended",
      detail: null,
      startedAt: request.now,
      settledAt: null,
    })
    .run();
}

export function settleOperation(
  db: CrewWriter,
  request: {
    operationId: string;
    attemptId: string;
    state: OperationState;
    detail: string | null;
    workspaceId?: string | null;
    paneId?: string | null;
    now: string;
  },
): void {
  db.update(externalOperations)
    .set({ state: request.state, detail: request.detail, settledAt: request.now })
    .where(eq(externalOperations.id, request.operationId))
    .run();

  const runtime = {
    ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
    ...(request.paneId === undefined ? {} : { paneId: request.paneId }),
  };
  if (Object.keys(runtime).length > 0) {
    db.update(attemptDispatch)
      .set({ ...runtime, updatedAt: request.now })
      .where(eq(attemptDispatch.attemptId, request.attemptId))
      .run();
  }
}

export function recordAcknowledgement(
  db: CrewWriter,
  request: { attemptId: string; operations: OperationRow[]; now: string },
): void {
  db.update(attemptDispatch)
    .set({ acknowledgedAt: request.now, updatedAt: request.now })
    .where(eq(attemptDispatch.attemptId, request.attemptId))
    .run();

  // An acknowledgement is the proof of delivery that a timed-out prompt call could not give.
  const delivery = operationFor(request.operations, "prompt_delivery");
  if (delivery !== null && delivery.state !== "succeeded") {
    settleOperation(db, {
      operationId: delivery.id,
      attemptId: request.attemptId,
      state: "succeeded",
      detail: "The Operative acknowledged the assignment.",
      now: request.now,
    });
  }
}

/** Ends one attempt without ending its assignment, which a replacement starts again. */
export function endAttempt(
  db: CrewWriter,
  request: { attempt: AttemptRow; state: string; now: string },
): void {
  db.update(attempts)
    .set({ state: request.state, endedAt: request.now, revision: request.attempt.revision + 1 })
    .where(eq(attempts.id, request.attempt.id))
    .run();
}

export function startAttempt(
  db: CrewWriter,
  request: { attemptId: string; assignmentId: string; ownerToken: string; now: string },
): void {
  db.insert(attempts)
    .values({
      id: request.attemptId,
      assignmentId: request.assignmentId,
      ownerToken: request.ownerToken,
      state: "active",
      revision: 1,
      startedAt: request.now,
      endedAt: null,
    })
    .run();
}

export function recordInspection(
  db: CrewWriter,
  request: { attemptId: string; inspection: unknown; identity: string; now: string },
): void {
  db.update(attemptDispatch)
    .set({
      inspection: JSON.stringify(request.inspection),
      inspectionIdentity: request.identity,
      updatedAt: request.now,
    })
    .where(eq(attemptDispatch.attemptId, request.attemptId))
    .run();
}

/** The stage a dispatch reached, derived from its recorded effects rather than stored twice. */
export function dispatchStage(context: AttemptContext): string {
  if (context.dispatch === null) {
    return "unplanned";
  }
  if (context.dispatch.acknowledgedAt !== null) {
    return "acknowledged";
  }

  const reached = DISPATCH_STAGES.filter(
    (stage) => operationFor(context.operations, stage)?.state === "succeeded",
  );
  return reached[reached.length - 1] ?? "planned";
}
