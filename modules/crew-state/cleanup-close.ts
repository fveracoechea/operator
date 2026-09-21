import { OperativeCleanup } from "../operative-cleanup/main.ts";
import { OperativeDispatch } from "../operative-dispatch/main.ts";
import {
  CLEANUP_OPERATION,
  type CleanupState,
  cleanupRevisionOf,
  type EvidenceItem,
  recordCleanup,
} from "./cleanup.ts";
import {
  type CleanupContext,
  type ContextFailure,
  heldArtifacts,
  inspectCheckout,
  readContext,
  record,
} from "./cleanup-context.ts";
import {
  checkoutBlockers,
  handoffBlockers,
  holdBlocker,
  identityBlocker,
} from "./cleanup-gates.ts";
import { matchIdentity } from "./cleanup-identity.ts";
import { type CleanupBlocker, type CleanupReport, reportOf } from "./cleanup-report.ts";
import { openOperation, settleOperation } from "./dispatch.ts";

export type CloseResult =
  | { status: "closed"; report: CleanupReport; repeated: boolean }
  | { status: "already-closed"; report: CleanupReport }
  | { status: "blocked"; report: CleanupReport; blockers: CleanupBlocker[] }
  | { status: "uncertain"; report: CleanupReport; detail: string }
  | { status: "failed"; report: CleanupReport; detail: string }
  | ContextFailure;

const KIND = "process_closure";

type Settlement = { state: CleanupState; detail: string; evidence: EvidenceItem[] | null };

/**
 * Writes one cleanup outcome and the external effect it settled.
 * Every path through a closure ends here, so a blocked, failed, uncertain, and finished run
 * are one record that survives the session rather than four ways of leaving no trace.
 */
async function settle(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  context: CleanupContext;
  requestRevision: string;
  inspection: unknown;
  settlement: Settlement;
  operation: { id: string; state: "intended" | "succeeded" | "failed" | "uncertain" } | null;
}) {
  const { context, settlement } = request;

  return record(
    {
      projectRoot: request.projectRoot,
      requestId: `${request.requestId}#${KIND}.${settlement.state}`,
      ownerToken: request.ownerToken,
      operation: "cleanup_close_record",
      input: {
        attemptId: context.attempt.id,
        state: settlement.state,
        detail: settlement.detail,
        requestRevision: request.requestRevision,
      },
    },
    ({ tx, now }) => {
      if (request.operation !== null && request.operation.state !== "intended") {
        settleOperation(tx, {
          operationId: request.operation.id,
          attemptId: context.attempt.id,
          state: request.operation.state,
          detail: settlement.detail,
          now,
        });
      }

      recordCleanup(tx, {
        cleanupId: crypto.randomUUID(),
        attemptId: context.attempt.id,
        assignmentId: context.assignment.id,
        kind: KIND,
        state: settlement.state,
        requestRevision: request.requestRevision,
        inspection: request.inspection,
        evidence: settlement.evidence,
        detail: settlement.detail,
        now,
      });
      return { commit: true, outcome: { status: "recorded" as const } };
    },
  );
}

/**
 * Closes one Operative process after its work is durably handed over.
 * It proves the artifacts are readable, the revisions still stand, no question waits, the
 * checkout holds nothing unregistered, the evidence lives outside the worktree, the host
 * stopped through its own stop keys, and its pane runs nothing this attempt started.
 * The checkout itself is untouched: disposal is a separate outcome with its own approval.
 */
export async function closeProcess(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  attemptId: string;
}): Promise<CloseResult> {
  const read = await readContext({
    projectRoot: request.projectRoot,
    attemptId: request.attemptId,
    ownerToken: request.ownerToken,
  });
  if (read.status !== "ok") {
    return read;
  }

  const context = read.context;
  const held = context.closure;
  const inspection = await inspectCheckout(context);
  const requestRevision = cleanupRevisionOf({
    workflowRevision: context.workflowRevision,
    kind: KIND,
    attemptId: context.attempt.id,
    assignmentId: context.assignment.id,
    worktreePath: context.dispatch.worktreePath,
    branch: context.dispatch.branch,
    inspectionIdentity: inspection.identity,
  });

  function report(state: string): CleanupReport {
    return reportOf({ context, kind: KIND, state, requestRevision, row: held });
  }

  if (held !== null && held.state === "done") {
    return { status: "already-closed", report: report("done") };
  }

  async function refuse(blockers: CleanupBlocker[]): Promise<CloseResult> {
    const detail = blockers.map((one) => one.reason).join(", ");
    const written = await settle({
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: request.ownerToken,
      context,
      requestRevision,
      inspection,
      settlement: { state: "blocked", detail, evidence: null },
      operation: null,
    });
    return written.status === "recorded"
      ? { status: "blocked", report: report("blocked"), blockers }
      : written;
  }

  const gates = [
    holdBlocker(context),
    ...handoffBlockers(context),
    ...checkoutBlockers(inspection, { requireRemote: false }),
  ].flatMap((one) => (one === null ? [] : [one]));
  if (gates.length > 0) {
    return refuse(gates);
  }

  const identity = await matchIdentity({ projectRoot: request.projectRoot, context });
  if (identity.status !== "matched") {
    return refuse([identityBlocker(identity)]);
  }

  const preserved = await OperativeCleanup.preserve({
    projectRoot: request.projectRoot,
    worktreePath: context.dispatch.worktreePath,
    attemptId: context.attempt.id,
    copies: OperativeDispatch.launchInputs(),
    held: heldArtifacts(context.submission),
  });
  if (preserved.status !== "preserved") {
    return refuse([
      preserved.status === "evidence-missing"
        ? { reason: "evidence_missing", name: preserved.name, path: preserved.path }
        : {
            reason: "evidence_changed",
            name: preserved.name,
            path: preserved.path,
            expected: preserved.expected,
            found: preserved.found,
          },
    ]);
  }

  // The intent is written before the stop, so a lost answer is reconciled from what Herdr
  // shows rather than repeated blindly into a host that already ended.
  const existing = context.operations.find((one) => one.kind === CLEANUP_OPERATION[KIND]) ?? null;
  const operationId = existing?.id ?? crypto.randomUUID();
  if (existing === null) {
    const opened = await record(
      {
        projectRoot: request.projectRoot,
        requestId: `${request.requestId}#${KIND}.open`,
        ownerToken: request.ownerToken,
        operation: "cleanup_close_intent",
        input: { attemptId: context.attempt.id, operationId },
      },
      ({ tx, now }) => {
        openOperation(tx, {
          operationId,
          attemptId: context.attempt.id,
          kind: CLEANUP_OPERATION[KIND],
          requestId: request.requestId,
          intent: { kind: KIND, agentName: context.dispatch.agentName },
          now,
        });
        recordCleanup(tx, {
          cleanupId: crypto.randomUUID(),
          attemptId: context.attempt.id,
          assignmentId: context.assignment.id,
          kind: KIND,
          state: "pending",
          requestRevision,
          inspection,
          evidence: preserved.items,
          detail: "The supported host stop was requested.",
          now,
        });
        return { commit: true, outcome: { status: "recorded" as const } };
      },
    );
    if (opened.status !== "recorded") {
      return opened;
    }
  }

  const stopped = await OperativeCleanup.stop({
    agentName: context.dispatch.agentName,
    agentHost: context.dispatch.agentHost,
  });

  if (stopped.status === "host-unsupported") {
    return refuse([{ reason: "host_unsupported", host: stopped.host }]);
  }
  if (stopped.status === "live") {
    return refuse([
      {
        reason: "writer_live",
        agentName: context.dispatch.agentName,
        agentStatus: stopped.agentStatus,
      },
    ]);
  }
  if (stopped.status === "uncertain") {
    const written = await settle({
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: request.ownerToken,
      context,
      requestRevision,
      inspection,
      settlement: { state: "uncertain", detail: stopped.detail, evidence: preserved.items },
      operation: { id: operationId, state: "uncertain" },
    });
    return written.status === "recorded"
      ? { status: "uncertain", report: report("uncertain"), detail: stopped.detail }
      : written;
  }

  // A review runs its two axes as sub-agents of one host, so a stopped Operative leaves no
  // agent and no child tool behind. Whatever is still here was never accounted for.
  const occupancy = await OperativeCleanup.occupancy({
    workspaceId: context.dispatch.workspaceId ?? "",
    paneId: context.dispatch.paneId ?? "",
  });
  if (occupancy.status === "unknown") {
    return refuse([{ reason: "occupancy_unknown", detail: occupancy.detail }]);
  }

  const strangers = occupancy.occupants.filter((one) => one !== context.dispatch.agentName);
  if (strangers.length > 0 || occupancy.childTools.length > 0) {
    return refuse([
      {
        reason: "unfamiliar_process",
        occupants: strangers,
        childTools: occupancy.childTools.map((one) => `${one.name} (${one.pid})`),
      },
    ]);
  }

  const detail = `${context.dispatch.agentName} stopped on ${context.dispatch.agentHost}.`;
  const written = await settle({
    projectRoot: request.projectRoot,
    requestId: request.requestId,
    ownerToken: request.ownerToken,
    context,
    requestRevision,
    inspection,
    settlement: { state: "done", detail, evidence: preserved.items },
    operation: { id: operationId, state: "succeeded" },
  });
  if (written.status !== "recorded") {
    return written;
  }

  const final = await readContext({
    projectRoot: request.projectRoot,
    attemptId: request.attemptId,
    ownerToken: null,
  });
  return {
    status: "closed",
    report: reportOf({
      context,
      kind: KIND,
      state: "done",
      requestRevision,
      row: final.status === "ok" ? final.context.closure : held,
    }),
    repeated: written.repeated,
  };
}
