import type { HerdrControl } from "../herdr-control/main.ts";
import { OperativeDispatch } from "../operative-dispatch/main.ts";
import type {
  Brief,
  DispatchPlan,
  Inspection,
  LaunchPlan,
  Snapshot,
  WorkInspection,
} from "./dispatch-context.ts";
import type { DirectionCheck, Unapproved } from "./direction.ts";
import type { AssignmentRow } from "./assignment.ts";
import type {
  AttemptContext,
  AttemptRole,
  DispatchRow,
  OperationRow,
  OperationState,
  ReworkContext,
} from "./dispatch.ts";
import type { BaseGateRefusal, BasePassed, BaseUnread } from "./gate-base.ts";
import type { IntegrationRefusal } from "./integration.ts";
import type { StateFailure } from "./operations.ts";
import type { ReviewRow } from "./review.ts";

/**
 * The attempt machine (ADR 0023, ADR 0005). One `attempts` row moves through these states.
 * Every event starts from `active`: the read of the attempt refuses an ended one with
 * `attempt-ended` before any guard runs. Each launch stage is one `external_operations` row in
 * the states of `OperationState`, and the acknowledgement is the `acknowledgedAt` of the plan.
 */
export type AttemptState = "active" | "submitted" | "accepted" | "replaced";

/** The events that move one attempt. */
export type AttemptEvent =
  | "dispatch"
  | "acknowledge"
  | "reconcile"
  | "adopt"
  | "replace"
  | "submit";

/** The external effects one launch performs, in the order a dispatch performs them. */
export const DISPATCH_STAGES = [
  "worktree_create",
  "input_preparation",
  "agent_start",
  "prompt_delivery",
] as const;

export type DispatchStage = (typeof DISPATCH_STAGES)[number];

/** A recorded kind this release still knows how to settle. */
export function isDispatchStage(kind: string): kind is DispatchStage {
  return DISPATCH_STAGES.some((stage) => stage === kind);
}

/**
 * The operations that recorded an intent and never proved an outcome.
 * An intended or uncertain effect may still have landed, so every reader of that state asks
 * this one question rather than spelling the two states again.
 */
export function unsettledOperations(operations: OperationRow[]): OperationRow[] {
  return operations.filter((one) => one.state === "intended" || one.state === "uncertain");
}

export function operationFor(operations: OperationRow[], kind: DispatchStage): OperationRow | null {
  return operations.find((one) => one.kind === kind) ?? null;
}

/** The rework cycle an attempt answers, or null for every other role. */
export function reworkOf(role: AttemptRole): ReworkContext | null {
  return role.kind === "rework" ? role.rework : null;
}

/** Where the launch of one active attempt stands, read from its plan and its stage records. */
export type LaunchState = "unplanned" | "launching" | "awaiting-acknowledgement" | "acknowledged";

/** One review, plus at most two replacements after a failure is inspected. */
export const REVIEW_ATTEMPT_LIMIT = 3;

/** What an unsettled effect proved, decided from what Herdr and the checkout show. */
export type Settlement = {
  state: Exclude<OperationState, "intended">;
  detail: string;
  workspaceId?: string;
  paneId?: string;
};

type StageRow = {
  // An intent that never settled runs again in place only where a repeat is harmless.
  resumes: boolean;
  // The "before" scan of a production attempt is recorded with the intent of this stage.
  scansOutside: boolean;
  settle: (inspection: Inspection, acknowledged: boolean) => Settlement;
};

/**
 * Decides one unproven submission from what the writer shows.
 * The Operative's own receipt is the only proof of arrival, and a timeout proves nothing.
 */
function settleDelivery(
  inspection: Inspection,
  acknowledged: boolean,
  subject: "assignment" | "answer",
): Settlement {
  if (acknowledged) {
    return { state: "succeeded", detail: `The Operative acknowledged the ${subject}.` };
  }
  if (inspection.writer.state === "stopped") {
    return {
      state: "failed",
      detail: `The agent that would have received the ${subject} is gone.`,
    };
  }

  return {
    state: "uncertain",
    detail: `The ${subject} may have reached a live Operative that has not acknowledged it. A timeout does not prove non-delivery.`,
  };
}

/**
 * The stage table. A launch performs the stages in the recorded order of `DISPATCH_STAGES`, and
 * a timeout never proves non-delivery, so an effect that stays unproven is left open.
 */
const STAGE_TABLE = {
  worktree_create: {
    resumes: false,
    scansOutside: false,
    settle: ({ checkout }) =>
      checkout.state === "unknown"
        ? { state: "uncertain", detail: checkout.detail }
        : checkout.state === "absent"
          ? { state: "failed", detail: "Herdr holds no checkout at the recorded path." }
          : { state: "succeeded", detail: "The recorded checkout exists." },
  },
  // Copying is verified and repeatable, so an unfinished copy is simply performed again.
  input_preparation: {
    resumes: true,
    scansOutside: false,
    settle: () => ({ state: "failed", detail: "The input copy did not finish, so it runs again." }),
  },
  // The scan is taken after the worktree exists, so the new checkout is not an outside change.
  agent_start: {
    resumes: false,
    scansOutside: true,
    settle: ({ writer }) =>
      writer.state === "unknown"
        ? { state: "uncertain", detail: writer.detail }
        : writer.state === "stopped"
          ? { state: "failed", detail: "Herdr holds no agent under the recorded name." }
          : {
              state: "succeeded",
              detail: `The recorded agent is live (${writer.status}).`,
              paneId: writer.paneId,
            },
  },
  prompt_delivery: {
    resumes: false,
    scansOutside: false,
    settle: (inspection, acknowledged) => settleDelivery(inspection, acknowledged, "assignment"),
  },
} satisfies Record<DispatchStage, StageRow>;

/** What one launch pass does with one stage. */
export type StageStep =
  | { run: "skip" }
  | { run: "open"; scansOutside: boolean }
  | { run: "resume"; operation: OperationRow }
  | { run: "reconcile"; operationState: string };

function launchStateOf(dispatch: DispatchRow | null, operations: OperationRow[]): LaunchState {
  if (dispatch === null) {
    return "unplanned";
  }
  const finished = DISPATCH_STAGES.every(
    (stage) => operationFor(operations, stage)?.state === "succeeded",
  );
  if (!finished) {
    return "launching";
  }
  return dispatch.acknowledgedAt === null ? "awaiting-acknowledgement" : "acknowledged";
}

type Row<F, D> = (facts: F) => D | null;

function firstOf<F, D>(rows: ReadonlyArray<Row<F, D>>, facts: F): D | null {
  for (const row of rows) {
    const decision = row(facts);
    if (decision !== null) {
      return decision;
    }
  }
  return null;
}

type NotDispatched = { status: "not-dispatched"; attemptId: string };
type Mismatch = { status: "reference-mismatch"; attemptId: string; detail: string };
type Pending = { status: "reconciliation-required"; attemptId: string; pending: string[] };
type WriterUnknown = { status: "writer-unknown"; attemptId: string; detail: string };
type SnapshotUnreadable = { status: "snapshot-unreadable"; attemptId: string; detail: string };
type Dispatched<F> = F & { dispatch: DispatchRow };

/** An attempt that never recorded a plan has nothing to settle, acknowledge, or replace. */
function dispatchedOf<F extends { attemptId: string }>(
  facts: F,
  dispatch: DispatchRow | null,
): { refused: NotDispatched } | { facts: Dispatched<F> } {
  return dispatch === null
    ? { refused: { status: "not-dispatched", attemptId: facts.attemptId } }
    : { facts: { ...facts, dispatch } };
}

function pendingOf(context: AttemptContext, attemptId: string): Pending | null {
  const pending = unsettledOperations(context.operations);
  return pending.length === 0
    ? null
    : { status: "reconciliation-required", attemptId, pending: pending.map((one) => one.kind) };
}

/** The Operative runs in the checkout its plan names, and in no other. */
const sameCheckout: Row<Dispatched<WriterFacts>, { refused: Mismatch }> = (facts) =>
  facts.dispatch.worktreePath === facts.worktreePath
    ? null
    : {
        refused: {
          status: "reference-mismatch",
          attemptId: facts.attemptId,
          detail: `This attempt is recorded against ${facts.dispatch.worktreePath}.`,
        },
      };

type WriterFacts = { attemptId: string; worktreePath: string; dispatch: DispatchRow | null };

type Requested = { baseCommit: string | null; branch: string | null; worktreePath: string | null };

type DispatchFacts = {
  context: AttemptContext;
  attemptId: string;
  requested: Requested;
  /** The pane this command runs in, or null when it runs outside Herdr. */
  parent?: Awaited<ReturnType<typeof HerdrControl.findPaneWorkspace>> | null;
  current?: Snapshot;
  integration?: { status: "ok"; start: string | null } | IntegrationRefusal | StateFailure;
  launch?: LaunchPlan;
  base?: { status: "ok"; base: BasePassed | null } | BaseGateRefusal | BaseUnread | StateFailure;
};

export type DispatchRefusal =
  | { status: "snapshot-drift"; attemptId: string; drift: SnapshotDrift[] }
  | SnapshotUnreadable
  | { status: "plan-changed"; attemptId: string; recorded: string; computed: string }
  | { status: "commit-required"; attemptId: string }
  | { status: "workspace-required"; attemptId: string; detail: string }
  | { status: "review-base-changed"; attemptId: string; recorded: string; requested: string }
  | { status: "correction-base-changed"; attemptId: string; recorded: string; requested: string }
  | { status: "host-unnamed"; attemptId: string }
  | { status: "effort-unsupported"; attemptId: string; detail: string }
  | Extract<LaunchPlan, { status: "project-gate-unusable" }>
  | BaseGateRefusal
  | BaseUnread
  | IntegrationRefusal
  | StateFailure;

type SnapshotDrift = ReturnType<typeof OperativeDispatch.verifySnapshot>[number];

/** The launch a dispatch records and performs. */
export type Launch = {
  snapshot: Snapshot;
  baseCommit: string;
  brief: Brief;
  plan: DispatchPlan;
  // The base that passed the gate, where this is the first code dispatch of its source.
  passed: BasePassed | null;
};

type DispatchDecision =
  | { refused: DispatchRefusal }
  | { need: "parent" | "current" | "integration" }
  | {
      need: "launch";
      snapshot: Snapshot;
      baseCommit: string;
      branch: string | null;
      worktreePath: string | null;
    }
  | { need: "base"; baseCommit: string }
  /** A finished launch has nothing left to perform, so a repeat reports what it recorded. */
  | {
      next: "active";
      repeated: Extract<LaunchState, "acknowledged" | "awaiting-acknowledgement">;
      dispatch: DispatchRow;
    }
  | { next: "active"; launch: Launch };

/** A recorded launch restores the snapshot it was planned with. */
function restoredOf(dispatch: DispatchRow) {
  return OperativeDispatch.readSnapshot({ recorded: dispatch.snapshot });
}

/** The snapshot a launch carries, or null before the current one is read. */
function snapshotOf(facts: DispatchFacts): Snapshot | null {
  const recorded = facts.context.dispatch;
  if (recorded !== null) {
    const restored = restoredOf(recorded);
    return restored.status === "read" ? restored.snapshot : null;
  }
  if (facts.current === undefined) {
    return null;
  }
  return facts.parent?.status === "found"
    ? { ...facts.current, parentWorkspaceId: facts.parent.value.workspaceId }
    : facts.current;
}

// A correction of a landed commit takes the place of that commit, so it starts on the parent
// that the invalidation recorded, and a dispatch that names no commit starts there.
function correctionBaseOf(context: AttemptContext): string | null {
  return reworkOf(context.role)?.brief.invalidation?.startCommit ?? null;
}

// A branch review reads one recorded head and no other, so a dispatch that names no commit
// starts there (ADR 0017).
function branchHeadOf(context: AttemptContext): string | null {
  const { role } = context;
  return role.kind === "branch-review" ? role.branchReview.snapshot.headCommit : null;
}

/** The base rule: the commit a launch starts from, in the order each source of it wins. */
function baseOf(facts: DispatchFacts): string | null {
  const start = facts.integration?.status === "ok" ? facts.integration.start : null;
  return (
    facts.context.dispatch?.baseCommit ??
    start ??
    facts.requested.baseCommit ??
    correctionBaseOf(facts.context) ??
    branchHeadOf(facts.context)
  );
}

const START_ROWS: ReadonlyArray<Row<DispatchFacts, DispatchDecision>> = [
  ({ context }) => {
    const state = launchStateOf(context.dispatch, context.operations);
    return context.dispatch !== null &&
      (state === "acknowledged" || state === "awaiting-acknowledgement")
      ? { next: "active", repeated: state, dispatch: context.dispatch }
      : null;
  },
  // A new launch opens beside the Operator, in the Herdr workspace of the pane it runs in.
  ({ context, attemptId, parent }) => {
    if (context.dispatch !== null) return null;
    if (parent === undefined) return { need: "parent" };
    if (parent?.status === "found") return null;
    return {
      refused: {
        status: "workspace-required",
        attemptId,
        detail:
          parent === null
            ? "This command is not running in a Herdr pane."
            : parent.status === "absent"
              ? "Herdr cannot find the Operator pane."
              : parent.detail,
      },
    };
  },
  ({ current }) => (current === undefined ? { need: "current" } : null),
  ({ context, attemptId, current }) => {
    if (context.dispatch === null || current === undefined) return null;
    const restored = restoredOf(context.dispatch);
    if (restored.status !== "read") {
      return { refused: { status: "snapshot-unreadable", attemptId, detail: restored.detail } };
    }
    const drift = OperativeDispatch.verifySnapshot({ recorded: restored.snapshot, current });
    return drift.length > 0 ? { refused: { status: "snapshot-drift", attemptId, drift } } : null;
  },
  // A production dispatch of a source with an integration branch starts from its recorded tip,
  // and a branch that moved outside this protocol stops it (ADR 0020).
  ({ integration }) => {
    if (integration === undefined) return { need: "integration" };
    return integration.status === "ok" ? null : { refused: integration };
  },
];

type Based = DispatchFacts & { snapshot: Snapshot; baseCommit: string };

const BASE_ROWS: ReadonlyArray<Row<Based, DispatchDecision>> = [
  ({ context, attemptId, baseCommit }) => {
    const recorded = correctionBaseOf(context);
    return recorded !== null && baseCommit !== recorded
      ? {
          refused: {
            status: "correction-base-changed",
            attemptId,
            recorded,
            requested: baseCommit,
          },
        }
      : null;
  },
  // A review reads the exact commit the result was submitted on, never a later one.
  ({ context, attemptId, baseCommit }) => {
    const { role } = context;
    const recorded =
      role.kind === "review" ? role.review.submission.reviewBase : branchHeadOf(context);
    return recorded !== null && baseCommit !== recorded
      ? { refused: { status: "review-base-changed", attemptId, recorded, requested: baseCommit } }
      : null;
  },
  // A recorded launch keeps the inputs it was planned with, so a request that names different
  // ones is a conflict rather than a silently ignored argument.
  ({ context, attemptId, requested, baseCommit }) => {
    const recorded = context.dispatch;
    if (recorded === null) return null;
    const changed = (
      [
        [requested.baseCommit, baseCommit],
        [requested.branch, recorded.branch],
        [requested.worktreePath, recorded.worktreePath],
      ] satisfies Array<[string | null, string]>
    ).find(([asked, held]) => asked !== null && asked !== held);
    return changed === undefined
      ? null
      : {
          refused: {
            status: "plan-changed",
            attemptId,
            recorded: changed[1],
            computed: changed[0] ?? "",
          },
        };
  },
];

const LAUNCH_ROWS: ReadonlyArray<Row<Based, DispatchDecision>> = [
  ({ context, launch, snapshot, baseCommit, requested }) => {
    if (launch === undefined) {
      return {
        need: "launch",
        snapshot,
        baseCommit,
        branch: context.dispatch?.branch ?? requested.branch,
        worktreePath: context.dispatch?.worktreePath ?? requested.worktreePath,
      };
    }
    return launch.status === "project-gate-unusable" ? { refused: launch } : null;
  },
  // A recorded plan fixed its base already, so only a new launch reads the base gate.
  ({ context, base, baseCommit }) => {
    if (context.dispatch !== null) return null;
    if (base === undefined) return { need: "base", baseCommit };
    return base.status === "ok" ? null : { refused: base };
  },
  ({ attemptId, launch }) =>
    launch?.status === "host-unnamed" ? { refused: { status: "host-unnamed", attemptId } } : null,
  ({ attemptId, launch }) =>
    launch?.status === "effort-unsupported"
      ? { refused: { status: "effort-unsupported", attemptId, detail: launch.detail } }
      : null,
  // The brief is fixed at dispatch, so a recomputed brief that differs is never delivered.
  ({ context, attemptId, launch }) => {
    const recorded = context.dispatch?.promptIdentity ?? null;
    return launch?.status === "planned" &&
      recorded !== null &&
      recorded !== launch.plan.promptIdentity
      ? {
          refused: {
            status: "plan-changed",
            attemptId,
            recorded,
            computed: launch.plan.promptIdentity,
          },
        }
      : null;
  },
];

function decideDispatch(facts: DispatchFacts): DispatchDecision {
  const started = firstOf(START_ROWS, facts);
  if (started !== null) {
    return started;
  }

  const snapshot = snapshotOf(facts);
  const baseCommit = baseOf(facts);
  if (snapshot === null) {
    return { need: "current" };
  }
  if (baseCommit === null) {
    return { refused: { status: "commit-required", attemptId: facts.attemptId } };
  }

  const based: Based = { ...facts, snapshot, baseCommit };
  const refused = firstOf(BASE_ROWS, based) ?? firstOf(LAUNCH_ROWS, based);
  if (refused !== null) {
    return refused;
  }
  if (based.launch?.status !== "planned") {
    throw new Error("A dispatch decided its launch before the launch rows passed.");
  }
  return {
    next: "active",
    launch: {
      snapshot,
      baseCommit,
      brief: based.launch.brief,
      plan: based.launch.plan,
      passed: based.base?.status === "ok" ? based.base.base : null,
    },
  };
}

type WriterDecision<Refusal, Next extends AttemptState> =
  | { refused: NotDispatched | Mismatch | Refusal }
  | { next: Next; dispatch: DispatchRow };

function decideWriter<Refusal, Next extends AttemptState>(
  facts: WriterFacts,
  last: Row<Dispatched<WriterFacts>, { refused: Refusal }>,
  next: Next,
): WriterDecision<Refusal, Next> {
  const dispatched = dispatchedOf(facts, facts.dispatch);
  if ("refused" in dispatched) {
    return dispatched;
  }
  return (
    firstOf<Dispatched<WriterFacts>, WriterDecision<Refusal, Next>>(
      [sameCheckout, last],
      dispatched.facts,
    ) ?? { next, dispatch: dispatched.facts.dispatch }
  );
}

type AdoptFacts = { context: AttemptContext; attemptId: string; inspection?: Inspection };

type AdoptDecision =
  | {
      refused:
        | { status: "already-adopted"; attemptId: string; assignmentId: string }
        | Pending
        | { status: "writer-stopped"; attemptId: string; agentName: string }
        | WriterUnknown;
    }
  | { need: "inspection"; dispatch: DispatchRow }
  | { next: "active" };

/**
 * Adoption runs only on an attempt whose effects are settled and whose Operative is still
 * running, because a stopped writer is replaced rather than adopted and an unproven effect is
 * reconciled first.
 */
const ADOPT_ROWS: ReadonlyArray<Row<AdoptFacts, AdoptDecision>> = [
  ({ context, attemptId }) =>
    context.current
      ? {
          refused: {
            status: "already-adopted",
            attemptId,
            assignmentId: context.attempt.assignmentId,
          },
        }
      : null,
  ({ context, attemptId }) => {
    const pending = pendingOf(context, attemptId);
    return pending === null ? null : { refused: pending };
  },
  ({ context, attemptId, inspection }) => {
    const dispatch = context.dispatch;
    if (dispatch === null) return null;
    if (inspection === undefined) return { need: "inspection", dispatch };
    const { writer } = inspection;
    if (writer.state === "stopped") {
      return {
        refused: { status: "writer-stopped", attemptId, agentName: dispatch.agentName },
      };
    }
    return writer.state === "unknown"
      ? { refused: { status: "writer-unknown", attemptId, detail: writer.detail } }
      : null;
  },
];

/** The review one replacement tries again, with the assignment that holds its direction. */
function reviewHeldOf(context: AttemptContext): { review: ReviewRow; holderId: string } | null {
  const { role } = context;
  switch (role.kind) {
    case "review":
      return { review: role.review.review, holderId: role.review.submission.assignmentId };
    // A branch review has no producer, so its own assignment carries the direction it waits on.
    case "branch-review":
      return { review: role.branchReview.review, holderId: context.assignment.id };
    default:
      return null;
  }
}

type ReplaceFacts = {
  context: AttemptContext;
  /** The attempt that is replaced. Every refusal names it. */
  attemptId: string;
  /** The attempt that takes its place. The new brief names it. */
  launchAttemptId: string;
  approvedInspection: string | null;
  direction?: DirectionCheck | StateFailure;
  inspection?: Inspection;
  launch?: LaunchPlan;
};

export type ReplaceRefusal =
  | NotDispatched
  | Pending
  | { status: "inspection-required"; attemptId: string; inspection: WorkInspection }
  | { status: "inspection-stale"; attemptId: string; inspection: WorkInspection; approved: string }
  | { status: "writer-live"; attemptId: string; agentName: string; paneId: string }
  | WriterUnknown
  | SnapshotUnreadable
  | Extract<LaunchPlan, { status: "project-gate-unusable" }>
  | StateFailure;

type ReplaceDecision =
  | { refused: ReplaceRefusal }
  | { need: "direction"; assignmentId: string }
  | { need: "inspection"; dispatch: DispatchRow }
  | { need: "launch"; snapshot: Snapshot; dispatch: DispatchRow }
  /** The review used every attempt it has, so the work waits on the user. */
  | {
      limit: { producerId: string; reviewId: string; attemptsHeld: number; approval: Unapproved };
    }
  | {
      next: "replaced";
      dispatch: DispatchRow;
      inspection: WorkInspection;
      snapshot: Snapshot;
      brief: Brief;
      plan: DispatchPlan;
      // The review that the replacement reviewer reports again, if it has not reported.
      reopen: ReviewRow | null;
      // The assignment whose direction this replacement spends, if it ran past the limit.
      spend: string | null;
    };

/** The snapshot the stopped writer was launched with, which its replacement keeps. */
function keptSnapshotOf(dispatch: DispatchRow) {
  return restoredOf(dispatch);
}

const REPLACE_ROWS: ReadonlyArray<Row<Dispatched<ReplaceFacts>, ReplaceDecision>> = [
  // A stopped or blocked review may be tried again, and a bounded number of times, so a failing
  // review host escalates to the user instead of consuming the crew.
  ({ context, direction }) => {
    const held = reviewHeldOf(context);
    if (
      held === null ||
      held.review.state === "reported" ||
      context.attemptsHeld < REVIEW_ATTEMPT_LIMIT
    ) {
      return null;
    }
    if (direction === undefined) return { need: "direction", assignmentId: held.holderId };
    if (direction.status === "directed") return null;
    return direction.status === "blocked" || direction.status === "unblocked"
      ? {
          limit: {
            producerId: held.holderId,
            reviewId: held.review.id,
            attemptsHeld: context.attemptsHeld,
            approval: direction.status === "blocked" ? direction.approval : "missing",
          },
        }
      : // The state could not be read, so nothing is replaced and nothing is recorded.
        { refused: direction };
  },
  ({ context, attemptId }) => {
    const pending = pendingOf(context, attemptId);
    return pending === null ? null : { refused: pending };
  },
  ({ dispatch, attemptId, inspection }) => {
    if (inspection === undefined) return { need: "inspection", dispatch };
    const { writer } = inspection;
    if (writer.state === "live") {
      return {
        refused: {
          status: "writer-live",
          attemptId,
          agentName: dispatch.agentName,
          paneId: writer.paneId,
        },
      };
    }
    return writer.state === "unknown"
      ? { refused: { status: "writer-unknown", attemptId, detail: writer.detail } }
      : null;
  },
  ({ attemptId, approvedInspection, inspection }) => {
    const work = inspection?.work;
    if (work === undefined || approvedInspection === work.identity) return null;
    return approvedInspection === null
      ? { refused: { status: "inspection-required", attemptId, inspection: work } }
      : {
          refused: {
            status: "inspection-stale",
            attemptId,
            inspection: work,
            approved: approvedInspection,
          },
        };
  },
  ({ dispatch, attemptId }) => {
    const restored = keptSnapshotOf(dispatch);
    return restored.status === "read"
      ? null
      : { refused: { status: "snapshot-unreadable", attemptId, detail: restored.detail } };
  },
  // A replacement reports a launch it cannot plan as a snapshot it cannot read.
  ({ dispatch, attemptId, launch }) => {
    if (launch === undefined) {
      const restored = keptSnapshotOf(dispatch);
      return restored.status === "read"
        ? { need: "launch", snapshot: restored.snapshot, dispatch }
        : null;
    }
    if (launch.status === "host-unnamed") {
      return {
        refused: {
          status: "snapshot-unreadable",
          attemptId,
          detail: "The recorded snapshot names no crew host.",
        },
      };
    }
    if (launch.status === "effort-unsupported") {
      return { refused: { status: "snapshot-unreadable", attemptId, detail: launch.detail } };
    }
    return launch.status === "project-gate-unusable" ? { refused: launch } : null;
  },
];

function decideReplace(facts: ReplaceFacts): ReplaceDecision {
  const dispatched = dispatchedOf(facts, facts.context.dispatch);
  if ("refused" in dispatched) {
    return dispatched;
  }
  const decided = firstOf(REPLACE_ROWS, dispatched.facts);
  if (decided !== null) {
    return decided;
  }

  const { context, dispatch, direction, inspection, launch } = dispatched.facts;
  const restored = keptSnapshotOf(dispatch);
  if (inspection === undefined || launch?.status !== "planned" || restored.status !== "read") {
    throw new Error("A replacement decided its launch before the replace rows passed.");
  }
  const held = reviewHeldOf(context);
  const open = held !== null && held.review.state !== "reported" ? held : null;
  return {
    next: "replaced",
    dispatch,
    inspection: inspection.work,
    snapshot: restored.snapshot,
    brief: launch.brief,
    plan: launch.plan,
    reopen: open?.review ?? null,
    spend: open !== null && direction?.status === "directed" ? open.holderId : null,
  };
}

type SubmitFacts = {
  attemptId: string;
  assignment: AssignmentRow;
  /** The revisions and the requirements the Operative states it produced the result against. */
  stated: { assignmentRevision: number; sourceRevision: string; requirementsIdentity: string };
  /** The identity of the requirements the assignment records now. */
  requirementsIdentity: string;
  /** The submission this attempt already recorded, if any. */
  held: { id: string } | null;
};

export type SubmitRefusal =
  | { status: "review-result-not-submitted"; assignmentId: string }
  | { status: "planning-only"; assignmentId: string; kind: string }
  | { status: "not-claimed"; assignmentId: string; state: string }
  | { status: "stale-revision"; assignmentId: string; recordedRevision: number }
  | { status: "source-revision-changed"; assignmentId: string; recordedRevision: string }
  | { status: "requirements-changed"; assignmentId: string; recordedIdentity: string }
  | { status: "already-submitted"; attemptId: string; submissionId: string };

/**
 * A submit records one fixed result and ends the attempt. Only a claimed production assignment
 * submits, and only against the revisions and the requirements it holds now.
 */
const SUBMIT_ROWS: ReadonlyArray<Row<SubmitFacts, { refused: SubmitRefusal }>> = [
  // A review report is not a submitted result, so it never starts another review.
  ({ assignment }) =>
    assignment.kind === "review"
      ? { refused: { status: "review-result-not-submitted", assignmentId: assignment.id } }
      : null,
  ({ assignment }) =>
    assignment.kind === "production"
      ? null
      : {
          refused: { status: "planning-only", assignmentId: assignment.id, kind: assignment.kind },
        },
  ({ assignment }) =>
    assignment.state === "claimed"
      ? null
      : {
          refused: { status: "not-claimed", assignmentId: assignment.id, state: assignment.state },
        },
  ({ assignment, stated }) =>
    assignment.revision === stated.assignmentRevision
      ? null
      : {
          refused: {
            status: "stale-revision",
            assignmentId: assignment.id,
            recordedRevision: assignment.revision,
          },
        },
  ({ assignment, stated }) =>
    assignment.sourceRevision === stated.sourceRevision
      ? null
      : {
          refused: {
            status: "source-revision-changed",
            assignmentId: assignment.id,
            recordedRevision: assignment.sourceRevision,
          },
        },
  ({ assignment, stated, requirementsIdentity }) =>
    requirementsIdentity === stated.requirementsIdentity
      ? null
      : {
          refused: {
            status: "requirements-changed",
            assignmentId: assignment.id,
            recordedIdentity: requirementsIdentity,
          },
        },
  ({ attemptId, held }) =>
    held === null
      ? null
      : { refused: { status: "already-submitted", attemptId, submissionId: held.id } },
];

/** What each event reads before it decides. The caller gathers each fact the decision needs. */
export type AttemptFacts = {
  dispatch: DispatchFacts;
  acknowledge: WriterFacts;
  submit: SubmitFacts;
  reconcile: { attemptId: string; dispatch: DispatchRow | null };
  adopt: AdoptFacts;
  replace: ReplaceFacts;
};

export type AttemptDecision = {
  dispatch: DispatchDecision;
  acknowledge: WriterDecision<
    { status: "already-acknowledged"; attemptId: string; acknowledgedAt: string },
    "active"
  >;
  submit: { refused: SubmitRefusal } | { next: "submitted" };
  reconcile: { refused: NotDispatched } | { next: "active"; dispatch: DispatchRow };
  adopt: AdoptDecision;
  replace: ReplaceDecision;
};

/** The transition table: each event, the decision of its guards in order, and its next state. */
const ATTEMPT_TABLE: {
  [E in AttemptEvent]: (facts: AttemptFacts[E]) => AttemptDecision[E];
} = {
  dispatch: decideDispatch,
  acknowledge: (facts) =>
    decideWriter(
      facts,
      ({ attemptId, dispatch }) =>
        dispatch.acknowledgedAt === null
          ? null
          : {
              refused: {
                status: "already-acknowledged",
                attemptId,
                acknowledgedAt: dispatch.acknowledgedAt,
              },
            },
      "active",
    ),
  submit: (facts) => firstOf(SUBMIT_ROWS, facts) ?? { next: "submitted" },
  reconcile: (facts) => {
    const dispatched = dispatchedOf(facts, facts.dispatch);
    return "refused" in dispatched
      ? dispatched
      : { next: "active", dispatch: dispatched.facts.dispatch };
  },
  adopt: (facts) => firstOf(ADOPT_ROWS, facts) ?? { next: "active" },
  replace: decideReplace,
};

export const Attempt = {
  /**
   * Decides one event on one attempt. It is pure: it reads only the facts the caller gathered.
   * It returns the first refusal in the order of the table, the next fact it needs, or the next
   * state with what the interpreter writes.
   */
  decide<E extends AttemptEvent>(event: E, facts: AttemptFacts[E]): AttemptDecision[E] {
    const decideEvent: (facts: AttemptFacts[E]) => AttemptDecision[E] = ATTEMPT_TABLE[event];
    return decideEvent(facts);
  },

  /**
   * The read every writer command makes, such as submit, report, or raise. It moves nothing:
   * the attempt stays active. An unacknowledged attempt never proved the brief arrived, so it
   * reports nothing fixed.
   */
  readWriter(facts: WriterFacts) {
    return decideWriter(
      facts,
      ({ attemptId, dispatch }) =>
        dispatch.acknowledgedAt === null
          ? { refused: { status: "not-acknowledged" as const, attemptId } }
          : null,
      "active",
    );
  },

  /** Where the launch of one active attempt stands. */
  launchState: launchStateOf,

  /** What one launch pass does with one stage, given the record a former pass left. */
  step(stage: DispatchStage, existing: OperationRow | null): StageStep {
    if (existing === null) {
      return { run: "open", scansOutside: STAGE_TABLE[stage].scansOutside };
    }
    if (existing.state === "succeeded") {
      return { run: "skip" };
    }
    // A Herdr effect that never settled may have landed, so it is reconciled, never repeated.
    return STAGE_TABLE[stage].resumes && existing.state === "intended"
      ? { run: "resume", operation: existing }
      : { run: "reconcile", operationState: existing.state };
  },

  /** Decides one unsettled stage from what Herdr and the checkout show. */
  settle(stage: DispatchStage, inspection: Inspection, acknowledged: boolean): Settlement {
    return STAGE_TABLE[stage].settle(inspection, acknowledged);
  },

  settleDelivery,
};
