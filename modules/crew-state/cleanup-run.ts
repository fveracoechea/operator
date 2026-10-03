import { OperativeCleanup } from "../operative-cleanup/main.ts";
import { OperativeDispatch } from "../operative-dispatch/main.ts";
import {
  CLEANUP_OPERATION,
  type CleanupKind,
  type CleanupRow,
  cleanupRecordOf,
  cleanupRevisionOf,
} from "./cleanup.ts";
import {
  type CleanupContext,
  type ContextFailure,
  heldArtifacts,
  inspectCheckout,
  readContext,
} from "./cleanup-context.ts";
import { matchIdentity } from "./cleanup-identity.ts";
import { landingBlockers } from "./cleanup-landing.ts";
import {
  Cleanup,
  CLEANUP_EVENT,
  type CleanupDecision,
  type CleanupFact,
  type CleanupFacts,
  type CleanupRunState,
} from "./cleanup-machine.ts";
import { removalApproval } from "./cleanup-remove.ts";
import type { CleanupBlocker, CleanupReport } from "./cleanup-report.ts";
import { cleanupWriter } from "./cleanup-write.ts";
import type { Shared } from "./cleanup-context.ts";

/** The names of the two finished outcomes, which differ by kind. */
const FINISHED = {
  process_closure: { done: "closed", already: "already-closed" },
  worktree_removal: { done: "removed", already: "already-removed" },
} as const satisfies Record<CleanupKind, { done: string; already: string }>;

type Finished = (typeof FINISHED)[CleanupKind];

export type CleanupResult =
  | { status: Finished["done"]; report: CleanupReport; repeated: boolean }
  | { status: Finished["already"]; report: CleanupReport }
  | { status: "blocked"; report: CleanupReport; blockers: CleanupBlocker[] }
  | { status: "uncertain" | "failed"; report: CleanupReport; detail: string }
  | ContextFailure;

type Request = {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  attemptId: string;
};

/** One cleanup run as it begins: the crew state it read, and the recorded state of its kind. */
type Run = {
  request: Request;
  kind: CleanupKind;
  context: CleanupContext;
  recorded: CleanupRow | null;
  state: CleanupRunState;
};

/**
 * Reads what both commands need before the first guard: the crew state under the ownership the
 * caller claims, the recorded row of this kind, and the effect a former run left open.
 */
async function beginCleanup(
  request: Request,
  kind: CleanupKind,
): Promise<{ run: Run; facts: CleanupFacts } | ContextFailure> {
  const read = await readContext({
    projectRoot: request.projectRoot,
    attemptId: request.attemptId,
    ownerToken: request.ownerToken,
  });
  if (read.status !== "ok") {
    return read;
  }

  const context = read.context;
  const recorded = context.cleanups.get(kind) ?? null;
  // An effect a former run opened is settled from what the host shows, never opened again.
  const operation = context.operations.find((one) => one.kind === CLEANUP_OPERATION[kind]);
  return {
    run: {
      request,
      kind,
      context,
      recorded,
      state: recorded === null ? "none" : cleanupRecordOf(recorded).state,
    },
    facts: { context, operationId: operation?.id ?? null },
  };
}

type Gather<K extends CleanupFact> = (run: Run, facts: CleanupFacts) => Promise<CleanupFacts[K]>;

/**
 * How each fact is gathered. `stopped` and `removed` run the outside effect, and the table asks
 * for them only after the intent of that effect is recorded.
 */
const GATHER: { [K in CleanupFact]: Gather<K> } = {
  inspection: ({ context }) => inspectCheckout(context),
  after: ({ context }) => inspectCheckout(context),
  identity: ({ request, context }) => matchIdentity({ projectRoot: request.projectRoot, context }),
  preserved: ({ request, context }) =>
    OperativeCleanup.preserve({
      projectRoot: request.projectRoot,
      worktreePath: context.dispatch.worktreePath,
      attemptId: context.attempt.id,
      copies: OperativeDispatch.launchInputs({
        briefIdentity: context.dispatch.briefIdentity,
        snapshot: context.dispatch.snapshot,
      }),
      held: heldArtifacts(context.submission),
    }),
  stopped: ({ context }) =>
    OperativeCleanup.stop({
      agentName: context.dispatch.agentName,
      agentHost: context.dispatch.agentHost,
    }),
  occupancy: (_run, facts) => {
    if (facts.identity?.status !== "matched") {
      throw new Error("The occupancy of a checkout was read before its identity matched.");
    }
    return OperativeCleanup.occupancy({
      workspaceId: facts.identity.checkout.workspaceId,
      paneId: facts.identity.paneId,
    });
  },
  recovery: ({ request, context }) =>
    OperativeCleanup.findCheckout({
      repoRoot: request.projectRoot,
      path: context.dispatch.worktreePath,
    }),
  landing: ({ request, context }) => landingBlockers({ projectRoot: request.projectRoot, context }),
  verified: ({ request, context }) => {
    const closure = context.cleanups.get("process_closure") ?? null;
    return OperativeCleanup.verify({
      projectRoot: request.projectRoot,
      items: closure === null ? [] : cleanupRecordOf(closure).evidence,
    });
  },
  approval: (run, facts) =>
    removalApproval({
      projectRoot: run.request.projectRoot,
      worktreePath: run.context.dispatch.worktreePath,
      workflowRevision: run.context.workflowRevision,
      cleanupRevision: writerOf(run, facts).requestRevision,
    }),
  removed: ({ request, context }, facts) => {
    if (facts.identity?.status !== "matched") {
      throw new Error("A checkout was removed before its identity matched.");
    }
    return OperativeCleanup.remove({
      repoRoot: request.projectRoot,
      workspaceId: facts.identity.checkout.workspaceId,
      worktreePath: context.dispatch.worktreePath,
    });
  },
};

async function gathered<K extends CleanupFact>(
  run: Run,
  facts: CleanupFacts,
  need: K,
): Promise<CleanupFacts> {
  const next: CleanupFacts = { ...facts };
  next[need] = await GATHER[need](run, facts);
  return next;
}

/**
 * The revision of the inputs one run acts on, which an approval must have been granted against.
 * It names the checkout as this run inspected it. A run that inspected nothing only reports the
 * outcome it already recorded, under the revision recorded with it.
 */
function revisionOf(run: Run, facts: CleanupFacts): string {
  const { context, kind } = run;
  if (facts.inspection !== undefined) {
    return cleanupRevisionOf({
      workflowRevision: context.workflowRevision,
      kind,
      attemptId: context.attempt.id,
      assignmentId: context.assignment.id,
      worktreePath: context.dispatch.worktreePath,
      branch: context.dispatch.branch,
      inspectionIdentity: facts.inspection.identity,
    });
  }
  if (run.recorded === null) {
    throw new Error("A cleanup wrote before it inspected the checkout.");
  }
  return run.recorded.requestRevision;
}

function writerOf(run: Run, facts: CleanupFacts) {
  return cleanupWriter({
    ...run.request,
    context: run.context,
    kind: run.kind,
    requestRevision: revisionOf(run, facts),
    inspection: facts.inspection ?? null,
  });
}

type Settled = Exclude<CleanupDecision, { need: unknown } | { stateFailure: unknown }>;

/** Writes one decision that ends the run, and reports it. */
async function apply(run: Run, facts: CleanupFacts, decision: Settled): Promise<CleanupResult> {
  const writer = writerOf(run, facts);
  if ("already" in decision) {
    return { status: FINISHED[run.kind].already, report: writer.report("done") };
  }
  if (decision.next === "blocked") {
    const written = await writer.refuse(decision.blockers);
    return written.status === "recorded"
      ? { status: "blocked", report: writer.report("blocked"), blockers: decision.blockers }
      : written;
  }
  if (decision.next === "pending") {
    throw new Error("A pending decision is written by the run, not settled.");
  }

  const written = await writer.settle({
    state: decision.next,
    detail: decision.detail,
    evidence: decision.evidence,
    operation:
      facts.operationId === null ? undefined : { id: facts.operationId, state: decision.operation },
  });
  if (written.status !== "recorded") {
    return written;
  }
  if (decision.next !== "done") {
    return { status: decision.next, report: writer.report(decision.next), detail: decision.detail };
  }
  return {
    status: FINISHED[run.kind].done,
    report: decision.reread ? await rereadReport(run, writer) : writer.report("done"),
    repeated: written.repeated,
  };
}

/** Reports the row this run wrote, read back from the crew state. */
async function rereadReport(
  run: Run,
  writer: ReturnType<typeof cleanupWriter>,
): Promise<CleanupReport> {
  const final = await readContext({
    projectRoot: run.request.projectRoot,
    attemptId: run.request.attemptId,
    ownerToken: null,
  });
  const row = final.status === "ok" ? (final.context.cleanups.get(run.kind) ?? null) : null;
  return writer.report("done", row ?? run.recorded);
}

/** Records the intent of the outside effect before it happens, under a new operation id. */
async function intend(
  run: Run,
  facts: CleanupFacts,
  decision: { intent: unknown; detail: string },
): Promise<{ status: "opened"; facts: CleanupFacts } | Shared> {
  const operationId = crypto.randomUUID();
  const opened = await writerOf(run, facts).intend({
    operationId,
    intent: decision.intent,
    detail: decision.detail,
  });
  return opened.status === "recorded"
    ? { status: "opened", facts: { ...facts, operationId } }
    : opened;
}

/**
 * Runs one cleanup command as the cleanup machine decides it. The interpreter gathers each fact
 * the table asks for, records the intent before an outside effect, and writes the outcome.
 */
export async function runCleanup(request: Request, kind: CleanupKind): Promise<CleanupResult> {
  const begun = await beginCleanup(request, kind);
  if (!("run" in begun)) {
    return begun;
  }

  const { run } = begun;
  let facts = begun.facts;
  for (;;) {
    const decision = Cleanup.decide(run.state, CLEANUP_EVENT[kind], facts);
    if ("need" in decision) {
      facts = await gathered(run, facts, decision.need);
    } else if ("stateFailure" in decision) {
      return decision.stateFailure;
    } else if (decision.next === "pending") {
      const opened = await intend(run, facts, decision);
      if (opened.status !== "opened") {
        return opened;
      }
      facts = opened.facts;
    } else {
      return apply(run, facts, decision);
    }
  }
}
