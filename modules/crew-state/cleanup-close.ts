import { OperativeCleanup } from "../operative-cleanup/main.ts";
import { OperativeDispatch } from "../operative-dispatch/main.ts";
import { cleanupRevisionOf } from "./cleanup.ts";
import {
  type ContextFailure,
  heldArtifacts,
  inspectCheckout,
  readContext,
} from "./cleanup-context.ts";
import {
  checkoutBlockers,
  handoffBlockers,
  holdBlocker,
  hostBlocker,
  identityBlocker,
  stillWritingBlockers,
} from "./cleanup-gates.ts";
import { matchIdentity } from "./cleanup-identity.ts";
import type { CleanupBlocker, CleanupReport } from "./cleanup-report.ts";
import { cleanupWriter } from "./cleanup-write.ts";

export type CloseResult =
  | { status: "closed"; report: CleanupReport; repeated: boolean }
  | { status: "already-closed"; report: CleanupReport }
  | { status: "blocked"; report: CleanupReport; blockers: CleanupBlocker[] }
  | { status: "uncertain"; report: CleanupReport; detail: string }
  | ContextFailure;

const KIND = "process_closure";

/**
 * Closes one Operative process after its work is durably handed over.
 * It proves the handoff, the revisions, the evidence, the answered questions, the stopped
 * writing, the identity of every resource, the accounted child tools, and the termination.
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
  const held = context.cleanups.get(KIND) ?? null;
  if (held !== null && held.state === "done") {
    return {
      status: "already-closed",
      report: cleanupWriter({
        ...request,
        context,
        kind: KIND,
        requestRevision: held.requestRevision,
        inspection: null,
      }).report("done"),
    };
  }

  // The host decides which paths Operator wrote, which keys stop it, and which pane it holds,
  // so a host this release cannot stop makes every later reading meaningless.
  const unknownHost = hostBlocker(context);
  const inspection = await inspectCheckout(context);
  const writer = cleanupWriter({
    ...request,
    context,
    kind: KIND,
    requestRevision: cleanupRevisionOf({
      workflowRevision: context.workflowRevision,
      kind: KIND,
      attemptId: context.attempt.id,
      assignmentId: context.assignment.id,
      worktreePath: context.dispatch.worktreePath,
      branch: context.dispatch.branch,
      inspectionIdentity: inspection.identity,
    }),
    inspection,
  });

  async function refuse(blockers: CleanupBlocker[]): Promise<CloseResult> {
    const written = await writer.refuse(blockers);
    return written.status === "recorded"
      ? { status: "blocked", report: writer.report("blocked"), blockers }
      : written;
  }

  if (unknownHost !== null) {
    return refuse([unknownHost]);
  }

  const gates = [
    holdBlocker(context),
    ...stillWritingBlockers({ context, inspection }),
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
    copies: OperativeDispatch.launchInputs({ briefIdentity: context.dispatch.briefIdentity }),
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

  // The intent is written before the stop, so a run that dies here is recovered from what
  // Herdr shows rather than repeated blindly into a host that already ended.
  const started = writer.openedOperation();
  const operationId = started?.id ?? crypto.randomUUID();
  if (started === null) {
    const opened = await writer.intend({
      operationId,
      intent: { kind: KIND, agentName: context.dispatch.agentName },
      detail: "The supported host stop was requested.",
    });
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
    const written = await writer.settle({
      state: "uncertain",
      detail: stopped.detail,
      evidence: preserved.items,
      operation: { id: operationId, state: "uncertain" },
    });
    return written.status === "recorded"
      ? { status: "uncertain", report: writer.report("uncertain"), detail: stopped.detail }
      : written;
  }

  // A stopped Operative writes nothing more, so the checkout must be exactly what it was when
  // this run read it. A checkout that moved was still being written while it was stopped.
  const after = await inspectCheckout(context);
  if (after.identity !== inspection.identity) {
    return refuse([
      { reason: "writer_active", state: context.attempt.state, checkout: after.worktreePath },
      ...checkoutBlockers(after, { requireRemote: false }),
    ]);
  }

  // A review runs its two axes as sub-agents of one host, so a stopped Operative leaves no
  // agent and no child tool behind. Whatever is still here was never accounted for.
  const occupancy = await OperativeCleanup.occupancy({
    workspaceId: identity.checkout.workspaceId,
    paneId: identity.paneId,
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

  const written = await writer.settle({
    state: "done",
    detail: `${context.dispatch.agentName} stopped on ${context.dispatch.agentHost}.`,
    evidence: preserved.items,
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
    report: writer.report(
      "done",
      final.status === "ok" ? (final.context.cleanups.get(KIND) ?? held) : held,
    ),
    repeated: written.repeated,
  };
}
