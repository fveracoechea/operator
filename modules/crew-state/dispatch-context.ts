import { OperativeDispatch } from "../operative-dispatch/main.ts";
import { ProjectGate } from "../project-gate/main.ts";
import { ProjectReadiness } from "../project-readiness/main.ts";
import {
  requiredCoverage,
  storedBehaviorChanges,
  storedChecks,
  storedCode,
  storedConcerns,
  storedDecisions,
  storedResultKind,
} from "./submission-input.ts";
import {
  ARTIFACT_RULES,
  INTERDIFF_INPUT,
  REVIEWED_PATCH_INPUT,
  specPathOf,
  storedArtifacts,
} from "./submission-store.ts";
import { reviewReadCommands, SUBMIT_RULES } from "./submission.ts";
import { BRANCH_REPORT_RULES, branchCoverage, REPORT_RULES } from "./review-report.ts";
import { storedFixedInputs, storedPermissions, storedRequirements } from "./work-input.ts";
import { REVIEW_AXES } from "./review.ts";
import {
  type AttemptContext,
  type BranchReviewContext,
  type ReviewContext,
  type ReworkContext,
  type AttemptLookup,
  type DispatchRow,
  dispatchStage,
  lookupAttempt,
  type OperationRow,
} from "./dispatch.ts";
import { Attempt } from "./attempt-machine.ts";
import { readState, type RequestFailure, type StateFailure } from "./operations.ts";
import { requireOwnership } from "./ownership.ts";
import { identityOf } from "./identity.ts";
import { gateOfAttempt } from "./integration.ts";
import {
  BEHAVIOR_CHANGE_RULE,
  type GateRead,
  ONE_COMMIT_RULE,
  PROJECT_GATE_RULE,
} from "./result-checks.ts";

export type Overrides = Parameters<typeof ProjectReadiness.snapshot>[0]["overrides"];

export type AttemptFailure = Exclude<AttemptLookup, { status: "ok" }>;

export type Shared = StateFailure | RequestFailure;

// A module states its shapes through its own interface, so these follow the dispatch methods.
type PlanRequest = Parameters<typeof OperativeDispatch.plan>[0];
export type Brief = PlanRequest["brief"];
export type Snapshot = PlanRequest["snapshot"];
export type DispatchPlan = Extract<
  ReturnType<typeof OperativeDispatch.plan>,
  { status: "planned" }
>["plan"];
export type Inspection = Awaited<ReturnType<typeof OperativeDispatch.inspect>>;
export type WorkInspection = Inspection["work"];

export type DispatchReport = {
  attemptId: string;
  assignmentId: string;
  stage: string;
  branch: string;
  baseCommit: string;
  worktreePath: string;
  agentName: string;
  agentHost: string;
  agentModel: string | null;
  reasoningEffort: string | null;
  promptIdentity: string;
  snapshotIdentity: string;
  operations: Array<{ kind: string; state: string; detail: string | null }>;
};

export type ContextRead =
  | { status: "ok"; context: AttemptContext }
  | AttemptFailure
  | StateFailure
  | RequestFailure;

type BriefRole = Brief["role"];
type ReviewBrief = Extract<BriefRole, { kind: "review" }>["review"];
type BranchReviewBrief = Extract<BriefRole, { kind: "branch-review" }>["branchReview"];
type ReworkBrief = Extract<BriefRole, { kind: "rework" }>["rework"];

/**
 * A writer command reads only an acknowledged attempt, so this line stands beside every command
 * that `readWriterContext` guards.
 */
const ACKNOWLEDGED_RULE = {
  refusal: "attempt_not_acknowledged",
  rule: "Run this only after the acknowledgement above succeeded.",
};

/** The fixed result one review reads, taken from the submission that started it. */
function reviewBriefOf(
  context: ReviewContext,
  request: { attemptId: string; producerTitle: string; fixedInputs: Brief["fixedInputs"] },
): ReviewBrief {
  const { review, submission } = context;
  const resultKind = storedResultKind(submission.resultKind);
  const behaviorChanges = storedBehaviorChanges(submission.behaviorChanges);
  const code = submission.code === null ? null : storedCode(submission.code);
  const specPath = specPathOf(submission.id);
  const spec = request.fixedInputs.find((one) => one.kind === "path" && one.value === specPath);
  // A combined revision of an integration cycle also fixed the reviewed patch and the interdiff.
  const copyOf = (name: string) => {
    const input = request.fixedInputs.find((one) => one.kind === "path" && one.name === name);
    return input?.contentIdentity == null
      ? null
      : { storedPath: input.value, contentIdentity: input.contentIdentity };
  };
  const reviewedPatch = copyOf(REVIEWED_PATCH_INPUT);
  const interdiff = copyOf(INTERDIFF_INPUT);
  return {
    reviewId: review.id,
    attemptId: request.attemptId,
    submissionId: submission.id,
    submissionIdentity: submission.identity,
    resultKind,
    axes: [...REVIEW_AXES],
    requiredCoverage: requiredCoverage(resultKind, behaviorChanges !== null),
    producerAssignmentId: submission.assignmentId,
    producerTitle: request.producerTitle,
    assignmentRevision: submission.assignmentRevision,
    sourceRevision: submission.sourceRevision,
    requirementsIdentity: submission.requirementsIdentity,
    reviewBase: submission.reviewBase,
    code,
    checks: storedChecks(submission.checks),
    concerns: storedConcerns(submission.concerns),
    decisions: storedDecisions(submission.decisions),
    behaviorChanges,
    artifacts: storedArtifacts(submission.artifacts),
    spec:
      spec?.contentIdentity == null
        ? null
        : { storedPath: spec.value, contentIdentity: spec.contentIdentity },
    fixedPoint: code?.baseCommit ?? null,
    readCommands: reviewReadCommands(code?.baseCommit ?? null),
    integration: reviewedPatch === null || interdiff === null ? null : { reviewedPatch, interdiff },
    basisQuestions: context.basisQuestions,
    priorRounds: context.priorRounds,
    publishes: context.publishes,
  };
}

/**
 * The fixed snapshot one branch review reads, taken from its registration. The spec copies and
 * the commands are its registered fixed inputs and permissions, so the brief adds none.
 */
function branchReviewBriefOf(
  context: BranchReviewContext,
  request: {
    attemptId: string;
    fixedInputs: Brief["fixedInputs"];
    allowedCommands: string[];
  },
): BranchReviewBrief {
  const { review, snapshot } = context;
  const readCommands = reviewReadCommands(snapshot.baseCommit);
  return {
    reviewId: review.id,
    attemptId: request.attemptId,
    sourceId: snapshot.sourceId,
    snapshotId: snapshot.id,
    snapshotIdentity: snapshot.identity,
    baseCommit: snapshot.baseCommit,
    headCommit: snapshot.headCommit,
    commits: context.commits,
    axes: [...REVIEW_AXES],
    requiredCoverage: branchCoverage(),
    specs: request.fixedInputs.flatMap((one) =>
      one.kind === "path" && one.name.startsWith("spec ") && one.contentIdentity !== null
        ? [{ name: one.name, storedPath: one.value, contentIdentity: one.contentIdentity }]
        : [],
    ),
    fixedPoint: snapshot.baseCommit,
    readCommands,
    // The registered commands that are neither a reviewer command nor a read command are the
    // project gate commands fixed on the integration branch.
    gateCommands: request.allowedCommands.filter(
      (one) => !readCommands.includes(one) && !one.startsWith("operator "),
    ),
    earlierReviews: context.earlierReviews,
  };
}

/**
 * The rules a branch review report refuses. They are the rules of every report, with the
 * snapshot in place of the submission, and the rules of finding targets.
 */
const BRANCH_RULES = [
  ...REPORT_RULES.map((one) =>
    one.refusal === "submission_drift"
      ? {
          refusal: "snapshot_drift",
          rule: "`snapshotIdentity` is the identity of the branch snapshot above.",
        }
      : one,
  ),
  ...BRANCH_REPORT_RULES,
];

/** The fixed cycle one rework attempt answers, as it was recorded when it was delegated. */
export function reworkBriefOf(context: ReworkContext): ReworkBrief {
  // An earlier release recorded an instruction, which is Operator text, and the Operator writes
  // nothing into a brief.
  const { instruction: _instruction, ...recorded } = context.brief;
  return { cycleId: context.cycle.id, ...recorded, rounds: context.rounds };
}

/** The one role of the brief, built from the role of the attempt that receives it. */
function roleOf(
  context: AttemptContext,
  request: { attemptId: string; fixedInputs: Brief["fixedInputs"]; allowedCommands: string[] },
): BriefRole {
  const { role } = context;
  switch (role.kind) {
    case "branch-review":
      return {
        kind: "branch-review",
        branchReview: branchReviewBriefOf(role.branchReview, request),
      };
    case "review": {
      const producerTitle = context.assignment.title;
      return { kind: "review", review: reviewBriefOf(role.review, { ...request, producerTitle }) };
    }
    case "rework":
      return { kind: "rework", rework: reworkBriefOf(role.rework) };
    case "production":
      return { kind: "production" };
  }
}

/** A rework Operative produces a result under the same rules as the producer it corrects. */
const PRODUCER_RULES: Brief["rules"] = {
  submit: [
    ACKNOWLEDGED_RULE,
    ONE_COMMIT_RULE,
    ...ARTIFACT_RULES,
    ...SUBMIT_RULES,
    BEHAVIOR_CHANGE_RULE,
    PROJECT_GATE_RULE,
  ],
  report: [],
};

/** A reviewer reports and never submits, so it receives none of the producer's rules. */
const RULES_OF_ROLE: Record<BriefRole["kind"], Brief["rules"]> = {
  production: PRODUCER_RULES,
  rework: PRODUCER_RULES,
  review: { submit: [], report: [ACKNOWLEDGED_RULE, ...REPORT_RULES] },
  "branch-review": { submit: [], report: [ACKNOWLEDGED_RULE, ...BRANCH_RULES] },
};

// A producer cannot show a gate that its base commit does not declare, so nothing launches.
export type GateUnusable = {
  status: "project-gate-unusable";
  attemptId: string;
  gate: Exclude<GateRead, { status: "declared" }>;
};

/**
 * The project gate a producer brief states (ADR 0021): the one fixed on the source with its
 * integration base, or, before the source has one, the one at the base commit of the launch.
 * A reviewer reads no gate here, because its registered commands already permit the gate.
 */
async function briefGate(request: {
  projectRoot: string;
  context: AttemptContext;
  attemptId: string;
  baseCommit: string;
}): Promise<{ status: "ok"; gate: Brief["gate"] } | GateUnusable> {
  if (request.context.role.kind === "review" || request.context.role.kind === "branch-review") {
    return { status: "ok", gate: null };
  }
  const gate = await gateOfAttempt({
    projectRoot: request.projectRoot,
    sourceId: request.context.assignment.sourceId,
    baseCommit: request.baseCommit,
  });
  return gate.status === "declared"
    ? {
        status: "ok",
        gate: {
          commit: gate.commit,
          commands: gate.commands.map((one) => ({
            name: one.name,
            line: ProjectGate.commandLine(one.argv),
            timeoutSeconds: one.timeoutSeconds,
          })),
        },
      }
    : { status: "project-gate-unusable", attemptId: request.attemptId, gate };
}

/** The fixed brief of one assignment, as the attempt that holds it receives it. */
export function briefOf(context: AttemptContext, attemptId: string, gate: Brief["gate"]): Brief {
  const assignment = context.assignment;
  const acceptanceRequirements = storedRequirements(assignment.acceptanceRequirements);
  const fixedInputs = storedFixedInputs(assignment.fixedInputs);
  const permissions = storedPermissions(assignment.permissions);
  const role = roleOf(context, {
    attemptId,
    fixedInputs,
    allowedCommands: permissions.allowedCommands,
  });
  return {
    assignmentId: assignment.id,
    assignmentRevision: assignment.revision,
    attemptId,
    sourceId: assignment.sourceId,
    sourceKey: assignment.sourceKey,
    sourceRevision: assignment.sourceRevision,
    title: assignment.title,
    kind: assignment.kind,
    acceptanceRequirements,
    requirementsIdentity: identityOf(acceptanceRequirements),
    approvedScope: assignment.approvedScope,
    permissions: { ...permissions, writePaths: context.writePaths },
    fixedInputs,
    // The records that the launch plan of this attempt fixed, so a recovery and a replacement
    // attempt restore the same words. A first launch carries the latest record of each one.
    planningRecords: context.planning.launched ?? context.planning.latest,
    rules: RULES_OF_ROLE[role.kind],
    gate,
    role,
  };
}

/** One launch that may start, or the reason its brief cannot launch. */
export type LaunchPlan =
  | { status: "planned"; brief: Brief; plan: DispatchPlan }
  | GateUnusable
  | { status: "host-unnamed" }
  | { status: "effort-unsupported"; detail: string };

/**
 * Plans the launch of one brief: the project gate it states, the brief, and the branch,
 * checkout, agent, and prompt. A dispatch and a replacement both plan through it, so one rule
 * says whether a brief can launch. Each caller maps a refusal to its own status.
 */
export async function planLaunch(request: {
  projectRoot: string;
  context: AttemptContext;
  /** The attempt a gate refusal names. */
  attemptId: string;
  /** The attempt the brief is for. A replacement plans the brief of the attempt it starts. */
  launchAttemptId: string;
  snapshot: Snapshot;
  baseCommit: string;
  branch: string | null;
  worktreePath: string | null;
}): Promise<LaunchPlan> {
  const gate = await briefGate(request);
  if (gate.status !== "ok") {
    return gate;
  }
  const brief = briefOf(request.context, request.launchAttemptId, gate.gate);
  const launch = OperativeDispatch.plan({
    projectRoot: request.projectRoot,
    brief,
    snapshot: request.snapshot,
    baseCommit: request.baseCommit,
    branch: request.branch,
    worktreePath: request.worktreePath,
  });
  return launch.status === "planned" ? { status: "planned", brief, plan: launch.plan } : launch;
}

export function reportOf(request: {
  attempt: { id: string; assignmentId: string };
  dispatch: DispatchRow;
  operations: OperationRow[];
  acknowledged: boolean;
}): DispatchReport {
  const { dispatch } = request;
  const recorded = OperativeDispatch.readSnapshot({ recorded: dispatch.snapshot });
  const crew = recorded.status === "read" ? recorded.snapshot.selection.crew : null;

  return {
    attemptId: request.attempt.id,
    assignmentId: request.attempt.assignmentId,
    stage: dispatchStage({ acknowledged: request.acknowledged, operations: request.operations }),
    branch: dispatch.branch,
    baseCommit: dispatch.baseCommit,
    worktreePath: dispatch.worktreePath,
    agentName: dispatch.agentName,
    agentHost: dispatch.agentHost,
    agentModel: crew?.model ?? null,
    reasoningEffort: crew?.reasoningEffort ?? null,
    promptIdentity: dispatch.promptIdentity,
    snapshotIdentity: dispatch.snapshotIdentity,
    operations: request.operations.map((one) => ({
      kind: one.kind,
      state: one.state,
      detail: one.detail,
    })),
  };
}

export function reportOfContext(context: AttemptContext, dispatch: DispatchRow): DispatchReport {
  return reportOf({
    attempt: context.attempt,
    dispatch,
    operations: context.operations,
    acknowledged: dispatch.acknowledgedAt !== null,
  });
}

/**
 * Reads one attempt under the ownership the caller claims.
 * A command that finds every stage already finished performs no mutation, so ownership is
 * checked here rather than only inside a write.
 */
export async function readContext(
  projectRoot: string,
  request: { attemptId: string; ownerToken: string | null; allowStale?: boolean },
): Promise<ContextRead> {
  return readState(projectRoot, (db) => {
    if (request.ownerToken !== null) {
      const check = requireOwnership(db, request.ownerToken);
      if (check.status === "unowned") {
        return { status: "unowned" as const };
      }
      if (check.status === "stale") {
        return { status: "ownership-stale" as const, ownership: check.ownership };
      }
    }

    const found = lookupAttempt(db, request.attemptId);
    return found.status === "ok" && !found.context.current && request.allowStale !== true
      ? { status: "attempt-not-current" as const, attemptId: request.attemptId }
      : found;
  });
}

export type WriterFailure =
  | { status: "not-dispatched"; attemptId: string }
  | { status: "not-acknowledged"; attemptId: string }
  | { status: "reference-mismatch"; attemptId: string; detail: string }
  | AttemptFailure
  | Shared;

export type WriterRead =
  | { status: "ok"; context: AttemptContext; dispatch: DispatchRow }
  | WriterFailure;

/**
 * Reads one attempt as the Operative or reviewer that runs in its worktree.
 * Both carry no ownership token, so the attempt must still be the current writer, must have
 * been launched, must run in the checkout it names, and must have acknowledged its brief.
 */
export async function readWriterContext(
  projectRoot: string,
  request: { attemptId: string; worktreePath: string },
): Promise<WriterRead> {
  const read = await readContext(projectRoot, {
    attemptId: request.attemptId,
    ownerToken: null,
  });
  if (read.status !== "ok") {
    return read;
  }

  const decision = Attempt.readWriter({ ...request, dispatch: read.context.dispatch });
  return "refused" in decision
    ? decision.refused
    : { status: "ok", context: read.context, dispatch: decision.dispatch };
}
