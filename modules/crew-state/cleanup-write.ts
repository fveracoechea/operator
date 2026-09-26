import {
  CLEANUP_OPERATION,
  type CleanupKind,
  type CleanupState,
  type EvidenceItem,
  recordCleanup,
} from "./cleanup.ts";
import { type CleanupContext, type Shared } from "./cleanup-context.ts";
import { record } from "./operations.ts";
import { type CleanupBlocker, type CleanupReport, reportOf } from "./cleanup-report.ts";
import {
  openOperation,
  type OperationRow,
  type OperationState,
  settleOperation,
} from "./dispatch.ts";

export type Settlement = {
  state: CleanupState;
  detail: string;
  evidence?: EvidenceItem[];
  operation?: { id: string; state: OperationState };
};

export type Written = { status: "recorded"; repeated: boolean } | Shared;

/**
 * The one way a cleanup writes what it did.
 * Closure and removal differ in what they prove, never in how they record it, so a blocked,
 * pending, failed, uncertain, and finished run all leave one row that survives the session.
 */
export function cleanupWriter(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  context: CleanupContext;
  kind: CleanupKind;
  requestRevision: string;
  inspection: unknown;
}) {
  const { context, kind, requestRevision } = request;

  return {
    /** The revision of the inputs this run acts on, which an approval must have been granted against. */
    requestRevision,

    /** The effect this cleanup already opened, if a former run left one behind. */
    openedOperation(): OperationRow | null {
      return context.operations.find((one) => one.kind === CLEANUP_OPERATION[kind]) ?? null;
    },

    report(state: CleanupState, row = context.cleanups.get(kind) ?? null): CleanupReport {
      return reportOf({ context, kind, state, requestRevision, row });
    },

    /** Records the intent of one external effect before it happens. */
    async intend(request_: {
      operationId: string;
      intent: unknown;
      detail: string;
    }): Promise<Written> {
      return record(
        {
          projectRoot: request.projectRoot,
          requestId: `${request.requestId}#${kind}.open`,
          ownerToken: request.ownerToken,
          operation: `cleanup_${kind}_intent`,
          input: { attemptId: context.attempt.id, operationId: request_.operationId },
        },
        ({ tx, now }) => {
          openOperation(tx, {
            operationId: request_.operationId,
            attemptId: context.attempt.id,
            kind: CLEANUP_OPERATION[kind],
            requestId: request.requestId,
            intent: request_.intent,
            now,
          });
          recordCleanup(tx, {
            cleanupId: crypto.randomUUID(),
            attemptId: context.attempt.id,
            assignmentId: context.assignment.id,
            kind,
            state: "pending",
            requestRevision,
            inspection: request.inspection,
            evidence: null,
            detail: request_.detail,
            now,
          });
          return { commit: true, outcome: { status: "recorded" as const } };
        },
      );
    },

    /** Records how this cleanup ended, and settles the effect it names. */
    async settle(settlement: Settlement): Promise<Written> {
      return record(
        {
          projectRoot: request.projectRoot,
          requestId: `${request.requestId}#${kind}.${settlement.state}`,
          ownerToken: request.ownerToken,
          operation: `cleanup_${kind}_record`,
          input: {
            attemptId: context.attempt.id,
            state: settlement.state,
            detail: settlement.detail,
            requestRevision,
          },
        },
        ({ tx, now }) => {
          if (settlement.operation !== undefined) {
            settleOperation(tx, {
              operationId: settlement.operation.id,
              attemptId: context.attempt.id,
              state: settlement.operation.state,
              detail: settlement.detail,
              now,
            });
          }

          recordCleanup(tx, {
            cleanupId: crypto.randomUUID(),
            attemptId: context.attempt.id,
            assignmentId: context.assignment.id,
            kind,
            state: settlement.state,
            requestRevision,
            inspection: request.inspection,
            evidence: settlement.evidence ?? null,
            detail: settlement.detail,
            now,
          });
          return { commit: true, outcome: { status: "recorded" as const } };
        },
      );
    },

    /** Records why this cleanup retained its resources, and names every blocker it found. */
    async refuse(blockers: CleanupBlocker[]): Promise<Written> {
      return this.settle({
        state: "blocked",
        detail: blockers.map((one) => one.reason).join(", "),
      });
    },
  };
}
