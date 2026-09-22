import { TrackerUpdate } from "../tracker-update/main.ts";
import { type ApprovalRow, approvalCovers, readApproval } from "./approvals.ts";
import type { CrewReader } from "./database.ts";
import { identityOf } from "./identity.ts";
import { parseInput } from "./input.ts";
import { readState, record, type RequestFailure, type StateFailure } from "./operations.ts";
import {
  observationsOf,
  openTrackerOperation,
  openWriteAttempt,
  readBinding,
  readTrackerOperation,
  recordObservation,
  recordResource,
  sentWrites,
  settleTrackerOperation,
  settleWriteAttempt,
  type TrackerBinding,
  type TrackerOperationRow,
  type TrackerStep,
  type TrackerTarget,
  type TrackerWriteRow,
  targetOf,
  trackerOperationFor,
  writeAttemptsOf,
} from "./tracker.ts";
import {
  storedObservation,
  storedProblems,
  storedReason,
  storedStep,
  storedTarget,
  storedVerdictState,
  storedWriteState,
  type TrackerProblem,
  type TrackerReason,
  type TrackerStepInput,
  trackerStepInputSchema,
} from "./tracker-input.ts";

type Shared = StateFailure | RequestFailure;

/**
 * Why another write under one operation is not permitted.
 * It travels beside the step's own outcome, so an unproven effect stays the overall result and
 * the approval problem is recorded rather than reported in its place.
 */
export type ApprovalBlocker =
  | {
      reason: "approval-required";
      action: string;
      targets: string[];
      scope: string;
      requestRevision: string;
    }
  | { reason: "unknown-approval"; approvalId: string }
  | { reason: "approval-revoked"; approvalId: string }
  | { reason: "approval-mismatch"; approvalId: string; field: string };

type Reading = Awaited<ReturnType<typeof TrackerUpdate.read>>;
type Observation = Reading["observation"];
type Verdict = Reading["verdict"];

// The report speaks the contract's own vocabulary rather than widening it back to text.
type VerdictState = Verdict["state"];

/** The action a person approves before another write is sent under one uncertain operation. */
const ADDITIONAL_WRITE = "tracker.additional_write";

export type TrackerStepReport = {
  operationId: string;
  assignmentId: string;
  step: TrackerStep;
  provider: string;
  target: TrackerTarget;
  expectedActor: string;
  /** The exact content this operation intends, so a person can compare it against what exists. */
  content: string | null;
  contentIdentity: string | null;
  closeReason: string | null;
  state: VerdictState;
  reason: TrackerReason;
  problems: TrackerProblem[];
  resourceId: string | null;
  resourceUrl: string | null;
  revision: number;
  writeAttempts: Array<{
    attemptId: string;
    requestId: string;
    approvalId: string | null;
    state: string;
    startedAt: string;
    settledAt: string | null;
  }>;
  observations: Array<{ kind: string; observedAt: string; observation: Observation }>;
};

export type TrackerResult =
  | { status: "reported"; report: TrackerStepReport }
  | { status: "invalid-input"; issues: string[] }
  | { status: "unknown-assignment"; assignmentId: string }
  | { status: "tracker-unbound"; assignmentId: string; detail: string }
  | { status: "unsupported-provider"; provider: string }
  | { status: "stale-revision"; assignmentId: string; recordedRevision: number }
  | { status: "target-mismatch"; recorded: TrackerTarget; stated: TrackerTarget }
  | { status: "map-target-missing"; assignmentId: string; sourceId: string }
  | { status: "capability-unavailable"; capability: string; detail: string }
  | { status: "actor-unknown"; detail: string }
  | { status: "content-changed"; operationId: string; recorded: string; stated: string }
  | { status: "write-blocked"; report: TrackerStepReport; approval: ApprovalBlocker }
  | { status: "unknown-operation"; operationId: string }
  | Shared;

function reportOf(request: {
  operation: TrackerOperationRow;
  attempts: TrackerWriteRow[];
  observations: Array<{ kind: string; observedAt: string; observation: string }>;
}): TrackerStepReport {
  const { operation } = request;
  return {
    operationId: operation.id,
    assignmentId: operation.assignmentId,
    step: storedStep(operation.step),
    provider: operation.provider,
    target: storedTarget(operation.target),
    expectedActor: operation.expectedActor,
    content: operation.content,
    contentIdentity: operation.contentIdentity,
    closeReason: operation.closeReason,
    state: storedVerdictState(operation.state),
    reason: storedReason(operation.reason),
    problems: storedProblems(operation.problems),
    resourceId: operation.resourceId,
    resourceUrl: operation.resourceUrl,
    revision: operation.revision,
    writeAttempts: request.attempts.map((one) => ({
      attemptId: one.id,
      requestId: one.requestId,
      approvalId: one.approvalId,
      state: one.state,
      startedAt: one.startedAt,
      settledAt: one.settledAt,
    })),
    observations: request.observations.map((one) => ({
      kind: one.kind,
      observedAt: one.observedAt,
      observation: storedObservation(one.observation),
    })),
  };
}

/** Reads one operation with everything a report about it needs. */
function readReport(db: CrewReader, operationId: string): TrackerStepReport | null {
  const operation = readTrackerOperation(db, operationId);
  return operation === null
    ? null
    : reportOf({
        operation,
        attempts: writeAttemptsOf(db, operationId),
        observations: observationsOf(db, operationId),
      });
}

/**
 * The approval one uncertain operation needs before another write is sent under it.
 * Its request revision is the number of write attempts already recorded, so one approval covers
 * exactly one additional write and cannot widen to a later one.
 */
function approvalCheckFor(request: {
  operation: TrackerOperationRow;
  target: TrackerTarget;
  attempts: TrackerWriteRow[];
}): {
  action: string;
  targets: string[];
  scope: string;
  requestRevision: string;
} {
  return {
    action: ADDITIONAL_WRITE,
    targets: [
      `${request.operation.provider}:${request.target.repository}#${request.target.issue}`,
      `operation:${request.operation.id}`,
    ],
    scope: request.operation.step,
    requestRevision: String(request.attempts.length),
  };
}

/**
 * Whether this call may write, read from what the tracker was just observed to show.
 * The contract reason decides: only a request the tracker refused is sent again.
 * A settled step stops, an evidence gap stops rather than writing over what it could not see,
 * and an unproven effect stops until a person approves another write.
 */
function gateBeforeWriting(request: {
  operation: TrackerOperationRow;
  attempts: TrackerWriteRow[];
  target: TrackerTarget;
  approval: ApprovalRow | null;
  approvalId: string | null;
}): { status: "proceed" } | { status: "stop" } | { status: "blocked"; approval: ApprovalBlocker } {
  const { operation } = request;
  const reason = storedReason(operation.reason);

  // Nothing observed stands in the way, or the tracker answered the request by refusing it.
  // A refused request may be sent again; it had no effect.
  if (reason === "tracker.pending" || reason === "tracker.write_rejected") {
    return { status: "proceed" };
  }

  // An unproven effect is the only outcome a person can accept the risk of writing over, and
  // only when there is an earlier effect to accept. Everything else stops with what it recorded.
  const unproven =
    reason === "tracker.resolution_outcome_unknown" ||
    reason === "tracker.completion_outcome_unknown" ||
    reason === "tracker.map_outcome_unknown";
  if (!unproven || sentWrites(request.attempts).length === 0) {
    return { status: "stop" };
  }

  const check = approvalCheckFor({
    operation,
    target: request.target,
    attempts: request.attempts,
  });

  // A named approval this crew does not hold is a different refusal from naming none.
  const approval = request.approval;
  if (request.approvalId !== null && approval === null) {
    return {
      status: "blocked",
      approval: { reason: "unknown-approval", approvalId: request.approvalId },
    };
  }
  if (approval === null) {
    return { status: "blocked", approval: { reason: "approval-required", ...check } };
  }

  const coverage = approvalCovers(approval, check);
  if (coverage.status === "mismatch") {
    return {
      status: "blocked",
      approval: { reason: "approval-mismatch", approvalId: approval.id, field: coverage.field },
    };
  }
  if (coverage.status === "revoked") {
    return {
      status: "blocked",
      approval: { reason: "approval-revoked", approvalId: approval.id },
    };
  }

  return { status: "proceed" };
}

type Context = {
  binding: TrackerBinding;
  assignmentRevision: number;
  target: TrackerTarget;
  operation: TrackerOperationRow | null;
  attempts: TrackerWriteRow[];
};

type ContextRead = { status: "ok"; context: Context } | TrackerResult;

function readContext(
  db: CrewReader,
  request: { assignmentId: string; step: TrackerStep },
): ContextRead {
  const bound = readBinding(db, request.assignmentId);
  if (bound.status === "unknown-assignment") {
    return bound;
  }
  if (bound.status === "tracker-unbound") {
    return bound;
  }
  if (bound.status === "unsupported-provider") {
    return { status: "unsupported-provider", provider: bound.provider };
  }

  const target = targetOf(bound.binding, request.step);
  if (target === null) {
    return {
      status: "map-target-missing",
      assignmentId: request.assignmentId,
      sourceId: bound.binding.sourceId,
    };
  }

  const operation = trackerOperationFor(db, request);
  return {
    status: "ok",
    context: {
      binding: bound.binding,
      assignmentRevision: bound.assignment.revision,
      target,
      operation,
      attempts: operation === null ? [] : writeAttemptsOf(db, operation.id),
    },
  };
}

/**
 * The write one recorded step intends, taken from the row that planned it.
 * A comment step holds its content and a completion step holds its reason. A row that holds
 * neither is damaged, and it fails loudly rather than writing an empty comment.
 */
function writeRequestFor(request: {
  operation: TrackerOperationRow;
  target: TrackerTarget;
}): Parameters<typeof TrackerUpdate.write>[0] {
  const { operation } = request;
  const step = storedStep(operation.step);
  if (step === "completion") {
    if (operation.closeReason === null) {
      throw new Error(`tracker operation ${operation.id} completes a ticket with no reason`);
    }
    return {
      provider: operation.provider,
      target: request.target,
      step,
      closeReason: operation.closeReason,
    };
  }

  if (operation.content === null) {
    throw new Error(`tracker operation ${operation.id} writes a comment with no content`);
  }
  return { provider: operation.provider, target: request.target, step, content: operation.content };
}

/**
 * Reads what the tracker shows now, judges the step against it, and records both.
 * An observation is a read, so it needs no approval and is the only way an uncertain write is
 * ever settled.
 */
async function settleFromObservation(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  operation: TrackerOperationRow;
  target: TrackerTarget;
  attempts: TrackerWriteRow[];
  extra?: TrackerProblem[];
}): Promise<{ status: "settled"; verdict: Verdict; observation: Observation } | Shared> {
  const { operation } = request;
  const sent = sentWrites(request.attempts);
  const { observation, verdict } = await TrackerUpdate.read({
    provider: operation.provider,
    step: storedStep(operation.step),
    target: request.target,
    operationId: operation.id,
    expectedActor: operation.expectedActor,
    contentIdentity: operation.contentIdentity,
    resourceId: operation.resourceId,
    // Only a completion judges against a reason, and its row always holds one.
    intendedReason: operation.closeReason ?? "",
    writes: sent.map((one) => storedWriteState(one.state)),
    extra: request.extra,
    now: new Date().toISOString(),
  });

  // A reading that found the intended comment names it, so a later recovery reads that resource
  // instead of scanning for it again. A lost answer therefore costs one scan, not every scan.
  const matched = observation.kind === "comment" ? observation.exactMatches : [];
  const found = operation.resourceId === null && matched.length === 1 ? (matched[0] ?? null) : null;

  // Each reading carries its own identity, so a replayed command records a new observation
  // instead of failing as the same request identity holding different input.
  const observationId = crypto.randomUUID();
  const written = await record(
    {
      projectRoot: request.projectRoot,
      requestId: `${request.requestId}#observe.${observationId}`,
      ownerToken: request.ownerToken,
      operation: "tracker_observe",
      input: { operationId: operation.id, observationId },
    },
    ({ tx, now }) => {
      recordObservation(tx, {
        observationId,
        operationId: operation.id,
        kind: observation.kind,
        observation,
        now,
      });
      if (found !== null) {
        recordResource(tx, {
          operationId: operation.id,
          resourceId: found.commentId,
          resourceUrl: found.url,
          now,
        });
      }
      settleTrackerOperation(tx, {
        operationId: operation.id,
        state: verdict.state,
        reason: verdict.reason,
        problems: verdict.problems,
        now,
      });
      return { commit: true, outcome: { status: "recorded" as const } };
    },
  );

  return written.status === "recorded" ? { status: "settled", verdict, observation } : written;
}

/** Marks a write whose process recorded no answer. It may have applied, so it is uncertain. */
async function settleLostWrites(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  operationId: string;
  attempts: TrackerWriteRow[];
}): Promise<{ status: "settled"; attempts: TrackerWriteRow[] } | Shared> {
  const lost = request.attempts.filter((one) => one.state === "intended");
  if (lost.length === 0) {
    return { status: "settled", attempts: request.attempts };
  }

  const written = await record(
    {
      projectRoot: request.projectRoot,
      requestId: `${request.requestId}#lost`,
      ownerToken: request.ownerToken,
      operation: "tracker_write_lost",
      input: { attempts: lost.map((one) => one.id) },
    },
    ({ tx, now }) => {
      for (const attempt of lost) {
        settleWriteAttempt(tx, {
          attemptId: attempt.id,
          operationId: request.operationId,
          state: "uncertain",
          response: { detail: "The process that sent this write recorded no answer." },
          resourceId: null,
          resourceUrl: null,
          now,
        });
      }
      return { commit: true, outcome: { status: "recorded" as const } };
    },
  );

  return written.status === "recorded"
    ? {
        status: "settled",
        attempts: request.attempts.map((one) =>
          one.state === "intended" ? { ...one, state: "uncertain" } : one,
        ),
      }
    : written;
}

async function finalReport(projectRoot: string, operationId: string): Promise<TrackerResult> {
  const read = await readState(projectRoot, (db) => readReport(db, operationId));
  if (read !== null && "status" in read) {
    return read;
  }

  return read === null
    ? { status: "unknown-operation", operationId }
    : { status: "reported", report: read };
}

/**
 * Records one step of one assignment's tracker update.
 * The intent is written before the effect, the write carries its own attempt record, and the
 * outcome is settled from what the tracker actually shows afterwards. A verified step is never
 * written again, and an uncertain one accepts another write only under a person's approval.
 */
export async function recordTrackerStep(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  assignmentId: string;
  revision: number;
  approvalId: string | null;
  input: unknown;
}): Promise<TrackerResult> {
  const parsed = parseInput(trackerStepInputSchema, request.input);
  if (parsed.status !== "parsed") {
    return parsed;
  }

  const input: TrackerStepInput = parsed.value;
  const read = await readState(request.projectRoot, (db) => {
    const context = readContext(db, { assignmentId: request.assignmentId, step: input.step });
    if (context.status !== "ok") {
      return context;
    }

    if (context.context.assignmentRevision !== request.revision) {
      return {
        status: "stale-revision" as const,
        assignmentId: request.assignmentId,
        recordedRevision: context.context.assignmentRevision,
      };
    }

    if (
      input.target !== undefined &&
      (input.target.repository !== context.context.target.repository ||
        input.target.issue !== context.context.target.issue)
    ) {
      return {
        status: "target-mismatch" as const,
        recorded: context.context.target,
        stated: input.target,
      };
    }

    return {
      status: "ok" as const,
      context: context.context,
      approval: request.approvalId === null ? null : readApproval(db, request.approvalId),
    };
  });

  if (read.status !== "ok") {
    return read;
  }

  const { target } = read.context;
  const intentIdentity = identityOf({ ...input, target });
  let attempts = read.context.attempts;
  let operation = read.context.operation;

  if (operation !== null) {
    // A verified step is finished. It is never written again to repair another step.
    if (operation.state === "verified") {
      return finalReport(request.projectRoot, operation.id);
    }

    if (operation.intentIdentity !== intentIdentity) {
      return {
        status: "content-changed",
        operationId: operation.id,
        recorded: operation.intentIdentity,
        stated: intentIdentity,
      };
    }

    const settledLost = await settleLostWrites({
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: request.ownerToken,
      operationId: operation.id,
      attempts,
    });
    if (settledLost.status !== "settled") {
      return settledLost;
    }
    attempts = settledLost.attempts;
  } else {
    // The rendered comment carries this identity in its marker, so the operation is named once
    // and the same bytes are rebuilt by every later recovery.
    const operationId = crypto.randomUUID();
    const planned = await TrackerUpdate.plan({
      provider: read.context.binding.provider,
      operationId,
      intent: { ...input, target },
    });
    if (planned.status === "unsupported-provider") {
      return { status: "unsupported-provider", provider: planned.provider };
    }
    if (planned.status === "capability-unavailable" || planned.status === "actor-unknown") {
      return planned;
    }

    // The plan is written before any effect, so an interrupted step is found and recovered.
    const opened = await record(
      {
        projectRoot: request.projectRoot,
        requestId: `${request.requestId}#plan`,
        ownerToken: request.ownerToken,
        operation: "tracker_plan",
        input: { assignmentId: request.assignmentId, step: input.step, intentIdentity },
      },
      ({ tx, now }) => {
        openTrackerOperation(tx, {
          operationId,
          assignmentId: request.assignmentId,
          step: input.step,
          provider: read.context.binding.provider,
          target,
          expectedActor: planned.expectedActor,
          intent: { ...input, target },
          intentIdentity,
          content: planned.content,
          contentIdentity: planned.contentIdentity,
          closeReason: planned.closeReason,
          now,
        });
        return { commit: true, outcome: { status: "recorded" as const } };
      },
    );
    if (opened.status !== "recorded") {
      return opened;
    }

    const stored = await readState(request.projectRoot, (db) =>
      readTrackerOperation(db, operationId),
    );
    if (stored !== null && "status" in stored) {
      return stored;
    }
    if (stored === null) {
      return { status: "unknown-operation", operationId };
    }

    operation = stored;
    attempts = [];
  }

  /**
   * What the tracker shows before this call writes anything.
   * A ticket's completion state exists whether or not Operator wrote it, and a step that already
   * sent a write may have landed. A new comment step has nothing to read: its marker cannot
   * exist before its own write.
   */
  if (storedStep(operation.step) === "completion" || attempts.length > 0) {
    const operationId = operation.id;
    const before = await settleFromObservation({
      projectRoot: request.projectRoot,
      requestId: `${request.requestId}#before`,
      ownerToken: request.ownerToken,
      operation,
      target,
      attempts,
    });
    if (before.status !== "settled") {
      return before;
    }

    const refreshed = await readState(request.projectRoot, (db) =>
      readTrackerOperation(db, operationId),
    );
    if (refreshed !== null && "status" in refreshed) {
      return refreshed;
    }
    if (refreshed === null) {
      return { status: "unknown-operation", operationId };
    }
    operation = refreshed;

    const gate = gateBeforeWriting({
      operation,
      attempts,
      target,
      approval: read.approval,
      approvalId: request.approvalId,
    });
    if (gate.status === "stop") {
      return finalReport(request.projectRoot, operationId);
    }
    if (gate.status === "blocked") {
      const blocked = await finalReport(request.projectRoot, operationId);
      return blocked.status === "reported"
        ? { status: "write-blocked", report: blocked.report, approval: gate.approval }
        : blocked;
    }
  }

  // A replay of one caller request returns what that request recorded. It never sends again.
  if (attempts.some((one) => one.requestId === request.requestId && one.state !== "intended")) {
    return finalReport(request.projectRoot, operation.id);
  }

  // The comment content is rendered from the identity of the operation that carries it, and it
  // is planned once. A later render of the same intent produces the same bytes.
  const planned = operation;
  const writeAttemptId = crypto.randomUUID();
  const openedWrite = await record(
    {
      projectRoot: request.projectRoot,
      requestId: `${request.requestId}#write.${writeAttemptId}`,
      ownerToken: request.ownerToken,
      operation: "tracker_write_open",
      input: { operationId: planned.id, attemptId: writeAttemptId },
    },
    ({ tx, now }) => {
      openWriteAttempt(tx, {
        attemptId: writeAttemptId,
        operationId: planned.id,
        requestId: request.requestId,
        approvalId: request.approvalId,
        now,
      });
      return { commit: true, outcome: { status: "recorded" as const } };
    },
  );
  if (openedWrite.status !== "recorded") {
    return openedWrite;
  }

  const sent = await TrackerUpdate.write(writeRequestFor({ operation: planned, target }));

  const settledWrite = await record(
    {
      projectRoot: request.projectRoot,
      requestId: `${request.requestId}#write.${writeAttemptId}.settle`,
      ownerToken: request.ownerToken,
      operation: "tracker_write_settle",
      input: { attemptId: writeAttemptId, state: sent.status },
    },
    ({ tx, now }) => {
      settleWriteAttempt(tx, {
        attemptId: writeAttemptId,
        operationId: planned.id,
        // A tool this machine does not have requested nothing, so nothing applied.
        state: sent.status === "unavailable" ? "failed" : sent.status,
        response: sent,
        resourceId: sent.status === "succeeded" ? sent.resourceId : null,
        resourceUrl: sent.status === "succeeded" ? sent.resourceUrl : null,
        now,
      });
      return { commit: true, outcome: { status: "recorded" as const } };
    },
  );
  if (settledWrite.status !== "recorded") {
    return settledWrite;
  }

  const after = await readState(request.projectRoot, (db) => ({
    operation: readTrackerOperation(db, planned.id),
    attempts: writeAttemptsOf(db, planned.id),
  }));
  if ("status" in after) {
    return after;
  }
  if (after.operation === null) {
    return { status: "unknown-operation", operationId: planned.id };
  }

  const settled = await settleFromObservation({
    projectRoot: request.projectRoot,
    requestId: `${request.requestId}#after`,
    ownerToken: request.ownerToken,
    operation: after.operation,
    target,
    attempts: after.attempts,
    // A capability this machine lacks outranks the refusal its absence produced.
    extra:
      sent.status === "unavailable"
        ? [{ reason: "tracker.capability_unavailable" as const, detail: sent.detail }]
        : [],
  });
  if (settled.status !== "settled") {
    return settled;
  }

  return finalReport(request.projectRoot, planned.id);
}

/**
 * Settles one recorded step from what the tracker shows now. It sends nothing.
 * A read that fails leaves the step where it was, because an unsuccessful read is not proof
 * that a write did not apply.
 */
export async function recoverTrackerStep(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  operationId: string;
}): Promise<TrackerResult> {
  const read = await readState(request.projectRoot, (db) => {
    const operation = readTrackerOperation(db, request.operationId);
    return operation === null
      ? null
      : { operation, attempts: writeAttemptsOf(db, request.operationId) };
  });
  if (read !== null && "status" in read) {
    return read;
  }
  if (read === null) {
    return { status: "unknown-operation", operationId: request.operationId };
  }

  const settledLost = await settleLostWrites({
    projectRoot: request.projectRoot,
    requestId: request.requestId,
    ownerToken: request.ownerToken,
    operationId: read.operation.id,
    attempts: read.attempts,
  });
  if (settledLost.status !== "settled") {
    return settledLost;
  }

  const settled = await settleFromObservation({
    projectRoot: request.projectRoot,
    requestId: request.requestId,
    ownerToken: request.ownerToken,
    operation: read.operation,
    target: storedTarget(read.operation.target),
    attempts: settledLost.attempts,
  });
  if (settled.status !== "settled") {
    return settled;
  }

  return finalReport(request.projectRoot, read.operation.id);
}
