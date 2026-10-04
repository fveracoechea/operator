import { HerdrControl } from "../herdr-control/main.ts";
import { OperativeDispatch } from "../operative-dispatch/main.ts";
import { launchedRecordIds } from "./planning-record.ts";
import { ProjectReadiness } from "../project-readiness/main.ts";
import {
  Attempt,
  type AttemptDecision,
  type AttemptFacts,
  DISPATCH_STAGES,
  type DispatchStage,
  type DispatchRefusal,
  type Launch,
  type StageStep,
} from "./attempt-machine.ts";
import {
  type AttemptFailure,
  type DispatchPlan,
  type DispatchReport,
  type Overrides,
  planLaunch,
  readContext,
  reportOf,
  reportOfContext,
  type Shared,
  type Snapshot,
} from "./dispatch-context.ts";
import { checkBaseGate } from "./gate-base.ts";
import {
  createIntegrationBranch,
  type IntegrationFix,
  type IntegrationRefusal,
  integrationStart,
  recordIntegrationBranch,
} from "./integration.ts";
import { record } from "./operations.ts";
import {
  type AttemptContext,
  type DispatchRow,
  type OperationRow,
  openOperation,
  recordOutsideScan,
  recordPlan,
  settleOperation,
} from "./dispatch.ts";

export type DispatchResult =
  | { status: "acknowledged"; report: DispatchReport; repeated: boolean }
  | { status: "awaiting-acknowledgement"; report: DispatchReport; repeated: boolean }
  | { status: "stage-failed"; report: DispatchReport; stage: DispatchStage; detail: string }
  | { status: "stage-uncertain"; report: DispatchReport; stage: DispatchStage; detail: string }
  | {
      status: "reconciliation-required";
      report: DispatchReport;
      stage: DispatchStage;
      operationState: string;
    }
  | DispatchRefusal
  | IntegrationRefusal
  | AttemptFailure
  | Shared;

type DispatchRequest = {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  attemptId: string;
  baseCommit: string | null;
  branch: string | null;
  worktreePath: string | null;
  paneId: string | null;
  overrides: Overrides;
};

type DispatchFacts = AttemptFacts["dispatch"];
type DispatchNeed = Extract<AttemptDecision["dispatch"], { need: string }>;

type StageOutcome =
  | { status: "succeeded"; detail: string; workspaceId?: string; paneId?: string }
  | { status: "failed"; detail: string }
  | { status: "uncertain"; detail: string };

type StageRun = {
  projectRoot: string;
  plan: DispatchPlan;
  snapshot: Snapshot;
  workspaceId: string | null;
};

/** The outside effect of each stage. The machine decides which stage runs, in recorded order. */
const STAGE_EFFECTS: Record<DispatchStage, (run: StageRun) => Promise<StageOutcome>> = {
  worktree_create: async ({ projectRoot, plan }) => {
    const created = await OperativeDispatch.createWorktree({ projectRoot, plan });
    return created.status === "succeeded"
      ? {
          status: "succeeded",
          detail: `Created ${created.value.worktreePath}.`,
          workspaceId: created.value.workspaceId,
        }
      : created.status === "failed"
        ? { status: "failed", detail: `${created.code}: ${created.detail}` }
        : { status: "uncertain", detail: created.detail };
  },
  input_preparation: async ({ projectRoot, plan, snapshot }) => {
    const prepared = await OperativeDispatch.prepare({ projectRoot, plan, snapshot });
    return prepared.status === "prepared"
      ? { status: "succeeded", detail: `Copied and verified ${prepared.inputs.length} input(s).` }
      : { status: "failed", detail: `${prepared.reason}: ${prepared.detail}` };
  },
  agent_start: async ({ plan, workspaceId }) => {
    if (workspaceId === null) {
      return { status: "failed", detail: "The recorded checkout names no Herdr workspace." };
    }

    const launched = await OperativeDispatch.launch({ plan, workspaceId });
    return launched.status === "succeeded"
      ? {
          status: "succeeded",
          detail: `Started ${plan.agentName} (${launched.value.status}) in pane ${launched.value.paneId}.${launched.value.labelWarning === null ? "" : ` ${launched.value.labelWarning}`}`,
          paneId: launched.value.paneId,
        }
      : launched.status === "failed"
        ? { status: "failed", detail: `${launched.code}: ${launched.detail}` }
        : { status: "uncertain", detail: launched.detail };
  },
  prompt_delivery: async ({ plan }) => {
    const delivered = await OperativeDispatch.deliver({ plan });
    return delivered.status === "succeeded"
      ? { status: "succeeded", detail: `Submitted the brief to ${plan.agentName}.` }
      : delivered.status === "failed"
        ? { status: "failed", detail: `${delivered.code}: ${delivered.detail}` }
        : { status: "uncertain", detail: delivered.detail };
  },
};

/** Reads the one fact the dispatch decision asked for. */
async function gather(
  request: DispatchRequest,
  facts: DispatchFacts,
  need: DispatchNeed,
): Promise<DispatchFacts> {
  const { projectRoot } = request;
  const { context, attemptId } = facts;
  switch (need.need) {
    case "parent":
      return {
        ...facts,
        parent:
          request.paneId === null
            ? null
            : await HerdrControl.findPaneWorkspace({ paneId: request.paneId }),
      };
    case "current":
      return {
        ...facts,
        current: await ProjectReadiness.snapshot({ projectRoot, overrides: request.overrides }),
      };
    case "integration":
      return {
        ...facts,
        integration: await integrationStart({
          projectRoot,
          context,
          attemptId,
          requested: request.baseCommit,
          planned: context.dispatch !== null,
        }),
      };
    case "launch":
      return {
        ...facts,
        launch: await planLaunch({
          projectRoot,
          context,
          attemptId,
          launchAttemptId: attemptId,
          snapshot: need.snapshot,
          baseCommit: need.baseCommit,
          branch: need.branch,
          worktreePath: need.worktreePath,
        }),
      };
    case "base":
      return {
        ...facts,
        base: await checkBaseGate({ projectRoot, context, attemptId, baseCommit: need.baseCommit }),
      };
  }
}

type Planned = { status: "planned"; context: AttemptContext; dispatch: DispatchRow };

/** Records the plan of a new launch, and reads the attempt again with the plan it holds now. */
async function recordLaunch(
  request: DispatchRequest,
  context: AttemptContext,
  launch: Launch,
): Promise<Planned | DispatchResult> {
  const attemptId = context.attempt.id;
  const { plan } = launch;
  // The first code dispatch creates the integration branch at a base that passed, just before its
  // plan is recorded with it. Nothing pushes the branch.
  let fix: IntegrationFix | null = null;
  if (launch.passed !== null) {
    const created = await createIntegrationBranch({
      projectRoot: request.projectRoot,
      sourceId: context.assignment.sourceId,
      attemptId,
      commit: launch.passed.commit,
      gate: launch.passed.gate,
    });
    if (created.status !== "created") {
      return created;
    }
    fix = created.fix;
  }

  if (context.dispatch === null) {
    const written = await record(
      {
        projectRoot: request.projectRoot,
        requestId: `${request.requestId}#plan`,
        ownerToken: request.ownerToken,
        operation: "attempt_dispatch_plan",
        input: { attemptId, plan: plan.promptIdentity },
      },
      ({ tx, now }) => {
        recordPlan(tx, {
          attemptId,
          assignmentId: context.attempt.assignmentId,
          baseCommit: plan.baseCommit,
          branch: plan.branch,
          worktreePath: plan.worktreePath,
          snapshot: launch.snapshot,
          snapshotIdentity: plan.snapshotIdentity,
          briefIdentity: plan.briefIdentity,
          promptIdentity: plan.promptIdentity,
          agentName: plan.agentName,
          agentKind: plan.agentKind,
          agentHost: plan.agentHost,
          planningRecordIds: launchedRecordIds(launch.brief.planningRecords),
          workspaceId: null,
          now,
        });
        if (fix !== null) {
          recordIntegrationBranch(tx, { sourceId: context.assignment.sourceId, fix, now });
        }
        return { commit: true, outcome: { status: "recorded" as const } };
      },
    );
    if (written.status !== "recorded") {
      return written;
    }
  }

  const planned = await readContext(request.projectRoot, request);
  if (planned.status !== "ok") {
    return planned;
  }
  return planned.context.dispatch === null
    ? { status: "unknown-attempt", attemptId }
    : { status: "planned", context: planned.context, dispatch: planned.context.dispatch };
}

type Stage = {
  stage: DispatchStage;
  step: Extract<StageStep, { run: "open" | "resume" }>;
  attemptId: string;
  production: boolean;
  launch: Launch;
  workspaceId: string | null;
};

/** Records the intent of one stage before it acts. */
async function openStage(
  request: DispatchRequest,
  pass: Stage & { passId: string; operationId: string },
) {
  const { stage, attemptId, operationId, launch } = pass;
  // The "before" scan of a production attempt is recorded with the intent of the start.
  const outsideScan =
    pass.step.run === "open" && pass.step.scansOutside && pass.production
      ? await OperativeDispatch.scanOutside({
          projectRoot: request.projectRoot,
          worktreePath: launch.plan.worktreePath,
        })
      : null;
  return record(
    {
      projectRoot: request.projectRoot,
      requestId: `${request.requestId}#${stage}.${pass.passId}.open`,
      ownerToken: request.ownerToken,
      operation: "attempt_dispatch_stage",
      input: { attemptId, stage, operationId },
    },
    ({ tx, now }) => {
      openOperation(tx, {
        operationId,
        attemptId,
        kind: stage,
        requestId: request.requestId,
        intent: { stage, plan: launch.plan.promptIdentity },
        now,
      });
      if (outsideScan !== null) {
        recordOutsideScan(tx, { attemptId, scan: outsideScan, now });
      }
      return { commit: true, outcome: { status: "recorded" as const } };
    },
  );
}

/** Performs one stage: its intent, its outside effect, and its outcome, each recorded. */
async function performStage(request: DispatchRequest, pass: Stage) {
  const { stage, attemptId, launch } = pass;
  const existing = pass.step.run === "resume" ? pass.step.operation : null;
  // The recorded effects decide what runs again, so each pass carries its own identity and a
  // repeated dispatch is never mistaken for a replay of the stage it is about to perform.
  const passId = crypto.randomUUID();
  const operationId = existing?.id ?? passId;
  if (existing === null) {
    const opened = await openStage(request, { ...pass, passId, operationId });
    if (opened.status !== "recorded") {
      return opened;
    }
  }

  const outcome = await STAGE_EFFECTS[stage]({
    projectRoot: request.projectRoot,
    plan: launch.plan,
    snapshot: launch.snapshot,
    workspaceId: pass.workspaceId,
  });
  const settled = await record(
    {
      projectRoot: request.projectRoot,
      requestId: `${request.requestId}#${stage}.${passId}.settle`,
      ownerToken: request.ownerToken,
      operation: "attempt_dispatch_stage_result",
      input: { operationId, state: outcome.status, detail: outcome.detail },
    },
    ({ tx, now }) => {
      const input: Parameters<typeof settleOperation>[1] = {
        operationId,
        attemptId,
        state: outcome.status,
        detail: outcome.detail,
        now,
      };
      if (outcome.status === "succeeded" && outcome.workspaceId !== undefined) {
        input.workspaceId = outcome.workspaceId;
      }
      if (outcome.status === "succeeded" && outcome.paneId !== undefined) {
        input.paneId = outcome.paneId;
      }
      settleOperation(tx, input);
      return { commit: true, outcome: { status: "recorded" as const } };
    },
  );
  if (settled.status !== "recorded") {
    return settled;
  }

  const operation: OperationRow = {
    ...(existing ?? {
      id: operationId,
      attemptId,
      kind: stage,
      requestId: request.requestId,
      intent: JSON.stringify({ stage, plan: launch.plan.promptIdentity }),
      startedAt: "",
      settledAt: null,
    }),
    state: outcome.status,
    detail: outcome.detail,
  };
  return { status: "settled" as const, outcome, operation };
}

/**
 * Performs every stage a former pass did not finish, in the recorded order.
 * Every stage records its intent before it acts and its outcome after, so an interrupted launch
 * is reconciled against Herdr instead of being repeated into a second writer.
 */
async function runStages(
  request: DispatchRequest,
  planned: Planned,
  launch: Launch,
): Promise<DispatchResult> {
  const { attempt, assignment } = planned.context;
  const operations = new Map(planned.context.operations.map((one) => [one.kind, one]));
  let workspaceId = planned.dispatch.workspaceId;

  function report(acknowledged = false): DispatchReport {
    const recorded = [...operations.values()];
    return reportOf({ attempt, dispatch: planned.dispatch, operations: recorded, acknowledged });
  }

  for (const stage of DISPATCH_STAGES) {
    const step = Attempt.step(stage, operations.get(stage) ?? null);
    if (step.run === "skip") {
      continue;
    }
    if (step.run === "reconcile") {
      const { operationState } = step;
      return { status: "reconciliation-required", report: report(), stage, operationState };
    }

    const production = assignment.kind === "production";
    const pass = { stage, step, attemptId: attempt.id, production, launch, workspaceId };
    const ran = await performStage(request, pass);
    if (ran.status !== "settled") {
      return ran;
    }
    operations.set(stage, ran.operation);

    const { outcome } = ran;
    if (outcome.status === "failed") {
      return { status: "stage-failed", report: report(), stage, detail: outcome.detail };
    }
    if (outcome.status === "uncertain") {
      return { status: "stage-uncertain", report: report(), stage, detail: outcome.detail };
    }
    workspaceId = outcome.workspaceId ?? workspaceId;
  }

  // The Operative can acknowledge while this dispatch is still delivering, so the answer is read
  // from the state rather than from what this call knew when it started.
  const final = await readContext(request.projectRoot, request);
  const acknowledged = final.status === "ok" && final.context.dispatch?.acknowledgedAt !== null;

  return acknowledged
    ? { status: "acknowledged", report: report(true), repeated: false }
    : { status: "awaiting-acknowledgement", report: report(), repeated: false };
}

/**
 * Dispatches one claimed assignment to an isolated Operative: the base rule, then the plan and
 * its record, then the stages. The attempt machine decides each refusal before any effect.
 */
export async function dispatchAttempt(request: DispatchRequest): Promise<DispatchResult> {
  const read = await readContext(request.projectRoot, request);
  if (read.status !== "ok") {
    return read;
  }

  const { context } = read;
  const { baseCommit, branch, worktreePath } = request;
  let facts: DispatchFacts = {
    context,
    attemptId: context.attempt.id,
    requested: { baseCommit, branch, worktreePath },
  };
  let decision = Attempt.decide("dispatch", facts);
  while ("need" in decision) {
    facts = await gather(request, facts, decision);
    decision = Attempt.decide("dispatch", facts);
  }
  if ("refused" in decision) {
    return decision.refused;
  }
  if ("repeated" in decision) {
    const report = reportOfContext(context, decision.dispatch);
    return { status: decision.repeated, report, repeated: true };
  }

  const planned = await recordLaunch(request, context, decision.launch);
  return planned.status === "planned" ? runStages(request, planned, decision.launch) : planned;
}
