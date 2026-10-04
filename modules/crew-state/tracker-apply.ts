import { TrackerUpdate } from "../tracker-update/main.ts";
import { type ApprovalRow, readApproval } from "./approvals.ts";
import type { CrewReader } from "./database.ts";
import { identityOf } from "./identity.ts";
import { parseInput } from "./input.ts";
import {
  latestPlanningRecord,
  type PlanningRecord,
  renderPlanningResolution,
  type RenderOutcome,
} from "./planning-record.ts";
import { readState, record, type RequestFailure, type StateFailure } from "./operations.ts";
import { trackerOperations } from "./schema.ts";
import { eq } from "drizzle-orm";
import { type MergeGate, mergeGateOf } from "./publish-status.ts";
import type { ApprovalRequest } from "./publish.ts";
import {
  mapAmendmentApproval,
  mapAmendmentPath,
  mapAmendmentText,
  mapAmendmentWaits,
} from "./map-amendment.ts";
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
import { type ApprovalBlocker, TrackerStep } from "./tracker-machine.ts";
import { isExecutable } from "./work-input.ts";

type Shared = StateFailure | RequestFailure;

type Reading = Awaited<ReturnType<typeof TrackerUpdate.read>>;
type Observation = Reading["observation"];
type Verdict = Reading["verdict"];

// The report speaks the contract's own vocabulary rather than widening it back to text.
type VerdictState = Verdict["state"];

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
  | { status: "planning-body-not-allowed"; assignmentId: string }
  | { status: "planning-record-missing"; assignmentId: string }
  | { status: "resolution-body-required"; assignmentId: string }
  | { status: "merge-not-observed"; assignmentId: string; detail: string }
  | { status: "code-resolution-body-not-allowed"; assignmentId: string }
  | { status: "completion-reason-not-approved"; assignmentId: string; reason: string }
  | { status: "publish-approval-missing"; assignmentId: string; approvalId: string; step: string }
  | {
      status: "map-amendment-approval-required";
      assignmentId: string;
      approval: ApprovalRequest;
      planPath: string;
    }
  | { status: "comment-too-long"; size: number; limit: number }
  | Exclude<RenderOutcome, { status: "rendered" }>
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

type Context = {
  binding: TrackerBinding;
  assignmentRevision: number;
  /** The record a planning resolution is rendered from, or null for executable work. */
  planning: { record: PlanningRecord | null } | null;
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
      planning: isExecutable(bound.assignment.kind)
        ? null
        : { record: latestPlanningRecord(db, request.assignmentId) },
      target,
      operation,
      attempts: operation === null ? [] : writeAttemptsOf(db, operation.id),
    },
  };
}

/** Reads one operation back after a write to it, or reports why it cannot be read. */
async function reload(
  projectRoot: string,
  operationId: string,
): Promise<{ status: "read"; operation: TrackerOperationRow } | TrackerResult> {
  const held = await readState(projectRoot, (db) => readTrackerOperation(db, operationId));
  if (held !== null && "status" in held) {
    return held;
  }

  return held === null
    ? { status: "unknown-operation", operationId }
    : { status: "read", operation: held };
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

type ResolvedStep = Exclude<TrackerStepInput, { step: "resolution" }> | ResolutionStep;
type ResolutionStep = Extract<TrackerStepInput, { step: "resolution" }> & { body: string };

/**
 * The step with the body it writes. The resolution of planning work is a rendering of its
 * planning record and takes no free text, so the tracker and the brief of a dependent carry the
 * same words. A production resolution keeps its own body.
 */
async function resolvedIntent(request: {
  projectRoot: string;
  assignmentId: string;
  input: TrackerStepInput;
  planning: Context["planning"];
  code: MergeGate;
}): Promise<{ status: "resolved"; input: ResolvedStep } | TrackerResult> {
  const { input, planning, code } = request;
  if (code.status !== "not-code") {
    return codeIntent({ assignmentId: request.assignmentId, input, code });
  }
  if (input.step !== "resolution") {
    return { status: "resolved", input };
  }

  if (planning === null) {
    return input.body === undefined
      ? { status: "resolution-body-required", assignmentId: request.assignmentId }
      : { status: "resolved", input: { ...input, body: input.body } };
  }
  if (input.body !== undefined) {
    return { status: "planning-body-not-allowed", assignmentId: request.assignmentId };
  }
  // Planning work that an earlier release accepted keeps no record, so nothing can be rendered.
  if (planning.record === null) {
    return { status: "planning-record-missing", assignmentId: request.assignmentId };
  }

  const rendered = await renderPlanningResolution({
    projectRoot: request.projectRoot,
    record: planning.record,
  });
  return rendered.status === "rendered"
    ? { status: "resolved", input: { ...input, body: rendered.body } }
    : rendered;
}

/**
 * The step of a code result. Each one runs only after the recorded merge of its pull request,
 * and only under the publish approval that named it (D2). The resolution is rendered from the
 * merge with no free body, and the completion closes the ticket as completed (decision 18). The
 * map amendment keeps its stated input, and its rendered text waits for a second approval.
 */
function codeIntent(request: {
  assignmentId: string;
  input: TrackerStepInput;
  code: Exclude<MergeGate, { status: "not-code" }>;
}): { status: "resolved"; input: ResolvedStep } | TrackerResult {
  const { assignmentId, input, code } = request;
  if (input.step === "resolution" && input.body !== undefined) {
    return { status: "code-resolution-body-not-allowed", assignmentId };
  }
  if (input.step === "completion" && input.reason !== "completed") {
    return { status: "completion-reason-not-approved", assignmentId, reason: input.reason };
  }
  if (code.status === "waiting") {
    return { status: "merge-not-observed", assignmentId, detail: code.detail };
  }
  if (!code.approved[input.step]) {
    return {
      status: "publish-approval-missing",
      assignmentId,
      approvalId: code.approvalId,
      step: input.step,
    };
  }
  return input.step === "resolution"
    ? { status: "resolved", input: { ...input, body: code.resolution } }
    : { status: "resolved", input };
}

/**
 * The planned map amendment of a code result that a new stated text replaces, or null. Only a
 * step whose text no approval binds yet, and that sent nothing, takes other text: the person may
 * reject the rendered text before any write.
 */
function replacedMapIntent(request: {
  code: MergeGate;
  operation: TrackerOperationRow | null;
  attempts: TrackerWriteRow[];
  intentIdentity: string;
  mapApproved: boolean;
}): string | null {
  const { operation } = request;
  return operation !== null &&
    request.code.status === "merged" &&
    storedStep(operation.step) === "map_amendment" &&
    request.attempts.length === 0 &&
    operation.intentIdentity !== request.intentIdentity &&
    !request.mapApproved
    ? operation.id
    : null;
}

/**
 * The map amendment of a code result writes only the exact text a `map-amendment` approval
 * binds (D2). With no such approval, the record renders the text to a local file and writes
 * nothing. Null means the step may go on.
 */
async function mapAmendmentGate(request: {
  projectRoot: string;
  code: MergeGate;
  operation: TrackerOperationRow;
  sent: boolean;
}): Promise<TrackerResult | null> {
  const { operation } = request;
  if (request.code.status !== "merged" || storedStep(operation.step) !== "map_amendment") {
    return null;
  }
  const waits = await readState(request.projectRoot, (db) =>
    mapAmendmentWaits(db, operation, request.sent),
  );
  if (typeof waits !== "boolean") {
    return waits;
  }
  if (!waits) {
    return null;
  }
  const planPath = mapAmendmentPath(operation.contentIdentity ?? operation.intentIdentity);
  await Bun.write(`${request.projectRoot}/${planPath}`, `${mapAmendmentText(operation)}\n`, {
    createPath: true,
  });
  return {
    status: "map-amendment-approval-required",
    assignmentId: operation.assignmentId,
    approval: mapAmendmentApproval(operation),
    planPath,
  };
}

/** The request of one record event, as each of its stages reads it. */
type RecordRequest = {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  assignmentId: string;
  revision: number;
  approvalId: string | null;
  input: unknown;
};

/** What the record event reads before its first stage. */
type RecordFacts = {
  context: Context;
  approval: ApprovalRow | null;
  code: MergeGate;
  /** Whether an approval already binds the text of the map amendment the step holds. */
  mapApproved: boolean;
};

/** What crosses from one stage to the next: the operation the step holds now, and its writes. */
type Held = { operation: TrackerOperationRow; attempts: TrackerWriteRow[]; target: TrackerTarget };

type Staged = { status: "held"; held: Held } | TrackerResult;

/** Reads the facts of one record event, or the refusal of a stale or misdirected request. */
function readRecordFacts(
  db: CrewReader,
  request: RecordRequest,
  input: TrackerStepInput,
): { status: "ok"; facts: RecordFacts } | TrackerResult {
  const read = readContext(db, { assignmentId: request.assignmentId, step: input.step });
  if (read.status !== "ok") {
    return read;
  }

  const { context } = read;
  if (context.assignmentRevision !== request.revision) {
    return {
      status: "stale-revision",
      assignmentId: request.assignmentId,
      recordedRevision: context.assignmentRevision,
    };
  }

  if (
    input.target !== undefined &&
    (input.target.repository !== context.target.repository ||
      input.target.issue !== context.target.issue)
  ) {
    return { status: "target-mismatch", recorded: context.target, stated: input.target };
  }

  return {
    status: "ok",
    facts: {
      context,
      approval: request.approvalId === null ? null : readApproval(db, request.approvalId),
      code: mergeGateOf(db, request.assignmentId),
      mapApproved:
        context.operation !== null &&
        !mapAmendmentWaits(db, context.operation, context.attempts.length > 0),
    },
  };
}

/**
 * The open stage: it resumes the operation the step holds, or plans a new one. A resumed step
 * first settles any write whose process recorded no answer.
 */
async function openOrResume(
  request: RecordRequest,
  facts: RecordFacts,
  intent: ResolvedStep,
): Promise<Staged> {
  const { context } = facts;
  const intentIdentity = identityOf({ ...intent, target: context.target });
  const replaced = replacedMapIntent({
    code: facts.code,
    operation: context.operation,
    attempts: context.attempts,
    intentIdentity,
    mapApproved: facts.mapApproved,
  });
  const decided = TrackerStep.decide("open", {
    operation: replaced === null ? context.operation : null,
    intentIdentity,
  });
  if ("refused" in decided) {
    return decided.refused;
  }

  const { next } = decided;
  if (next.stage === "report") {
    return finalReport(request.projectRoot, next.operationId);
  }

  const opened =
    next.stage === "resume"
      ? await resumeOperation(request, { ...context, operation: next.operation })
      : await planOperation(request, { context, intent, intentIdentity, replaced });
  if (opened.status !== "held") {
    return opened;
  }

  const textGate = await mapAmendmentGate({
    projectRoot: request.projectRoot,
    code: facts.code,
    operation: opened.held.operation,
    sent: opened.held.attempts.length > 0,
  });
  return textGate ?? opened;
}

async function resumeOperation(request: RecordRequest, held: Held): Promise<Staged> {
  const settledLost = await settleLostWrites({
    projectRoot: request.projectRoot,
    requestId: request.requestId,
    ownerToken: request.ownerToken,
    operationId: held.operation.id,
    attempts: held.attempts,
  });
  return settledLost.status === "settled"
    ? {
        status: "held",
        held: { operation: held.operation, attempts: settledLost.attempts, target: held.target },
      }
    : settledLost;
}

async function planOperation(
  request: RecordRequest,
  plan: { context: Context; intent: ResolvedStep; intentIdentity: string; replaced: string | null },
): Promise<Staged> {
  const { context, intent, intentIdentity, replaced } = plan;
  const { binding, target } = context;
  // The rendered comment carries this identity in its marker, so the operation is named once
  // and the same bytes are rebuilt by every later recovery.
  const operationId = crypto.randomUUID();
  const planned = await TrackerUpdate.plan({
    provider: binding.provider,
    operationId,
    intent: { ...intent, target },
  });
  if (planned.status !== "planned") {
    return planned;
  }

  // The plan is written before any effect, so an interrupted step is found and recovered.
  const opened = await record(
    {
      projectRoot: request.projectRoot,
      requestId: `${request.requestId}#plan`,
      ownerToken: request.ownerToken,
      operation: "tracker_plan",
      input: { assignmentId: request.assignmentId, step: intent.step, intentIdentity },
    },
    ({ tx, now }) => {
      if (replaced !== null) {
        tx.delete(trackerOperations).where(eq(trackerOperations.id, replaced)).run();
      }
      openTrackerOperation(tx, {
        operationId,
        assignmentId: request.assignmentId,
        step: intent.step,
        provider: binding.provider,
        target,
        expectedActor: planned.expectedActor,
        intent: { ...intent, target },
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

  const stored = await reload(request.projectRoot, operationId);
  return stored.status === "read"
    ? { status: "held", held: { operation: stored.operation, attempts: [], target } }
    : stored;
}

/**
 * The observe stage: what the tracker shows before this call writes anything, and whether this
 * call may write over it.
 */
async function observeBefore(
  request: RecordRequest,
  approval: ApprovalRow | null,
  held: Held,
): Promise<Staged> {
  const observe = TrackerStep.decide("observe", held);
  if ("next" in observe && observe.next === "write") {
    return { status: "held", held };
  }

  const operationId = held.operation.id;
  const before = await settleFromObservation({
    projectRoot: request.projectRoot,
    requestId: `${request.requestId}#before`,
    ownerToken: request.ownerToken,
    ...held,
  });
  if (before.status !== "settled") {
    return before;
  }

  const refreshed = await reload(request.projectRoot, operationId);
  if (refreshed.status !== "read") {
    return refreshed;
  }

  const gate = TrackerStep.decide("gate", {
    ...held,
    operation: refreshed.operation,
    approvalId: request.approvalId,
    approval,
  });
  if ("refused" in gate) {
    const blocked = await finalReport(request.projectRoot, operationId);
    return blocked.status === "reported"
      ? { status: "write-blocked", report: blocked.report, approval: gate.refused }
      : blocked;
  }

  return gate.next === "report"
    ? finalReport(request.projectRoot, operationId)
    : { status: "held", held: { ...held, operation: refreshed.operation } };
}

/** The write stage: one write with its own attempt record, settled from what the tracker shows. */
async function writeAndSettle(request: RecordRequest, held: Held): Promise<TrackerResult> {
  // The comment content is rendered from the identity of the operation that carries it, and it
  // is planned once. A later render of the same intent produces the same bytes.
  const { operation: planned, target } = held;
  const write = TrackerStep.decide("write", {
    attempts: held.attempts,
    requestId: request.requestId,
  });
  if ("next" in write && write.next === "report") {
    return finalReport(request.projectRoot, planned.id);
  }

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

  const after = await reload(request.projectRoot, planned.id);
  if (after.status !== "read") {
    return after;
  }
  const settledAttempts = await readState(request.projectRoot, (db) =>
    writeAttemptsOf(db, planned.id),
  );
  if ("status" in settledAttempts) {
    return settledAttempts;
  }

  const settled = await settleFromObservation({
    projectRoot: request.projectRoot,
    requestId: `${request.requestId}#after`,
    ownerToken: request.ownerToken,
    operation: after.operation,
    target,
    attempts: settledAttempts,
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
 * Records one step of one assignment's tracker update.
 * The intent is written before the effect, the write carries its own attempt record, and the
 * outcome is settled from what the tracker actually shows afterwards. A verified step is never
 * written again, and an uncertain one accepts another write only under a person's approval.
 * The stages run in the order of the tracker step machine, and each one decides through it.
 */
export async function recordTrackerStep(request: RecordRequest): Promise<TrackerResult> {
  const parsed = parseInput(trackerStepInputSchema, request.input);
  if (parsed.status !== "parsed") {
    return parsed;
  }

  const input: TrackerStepInput = parsed.value;
  const read = await readState(request.projectRoot, (db) => readRecordFacts(db, request, input));
  if (read.status !== "ok") {
    return read;
  }

  const { facts } = read;
  const resolved = await resolvedIntent({
    projectRoot: request.projectRoot,
    assignmentId: request.assignmentId,
    input,
    planning: facts.context.planning,
    code: facts.code,
  });
  if (resolved.status !== "resolved") {
    return resolved;
  }

  const opened = await openOrResume(request, facts, resolved.input);
  if (opened.status !== "held") {
    return opened;
  }

  const observed = await observeBefore(request, facts.approval, opened.held);
  return observed.status === "held" ? writeAndSettle(request, observed.held) : observed;
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
