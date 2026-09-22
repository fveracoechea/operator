import {
  allCleanups,
  allRetentionHolds,
  type CleanupKind,
  type CleanupRow,
  cleanupRecordOf,
  type CleanupState,
  type EvidenceItem,
} from "./cleanup.ts";
import type { CleanupContext } from "./cleanup-context.ts";
import type { IdentityMismatch } from "./cleanup-identity.ts";
import { readState, type StateFailure } from "./operations.ts";
import { STATE_VERSION } from "./schema.ts";

/** One reason a cleanup retained its resources. Every blocker names what a person must settle. */
export type CleanupBlocker =
  | { reason: "retention_hold"; holdReason: string; detail: string }
  | { reason: "handoff_missing"; detail: string }
  | { reason: "revisions_changed"; input: string; recorded: string; found: string }
  | { reason: "question_open"; questionId: string; state: string }
  | { reason: "unexpected_work"; paths: string[] }
  | { reason: "unexpected_files"; paths: string[] }
  | { reason: "unpushed_commits"; commits: string[] }
  | { reason: "evidence_missing"; name: string; path: string }
  | { reason: "evidence_changed"; name: string; path: string; expected: string; found: string }
  | { reason: "unfamiliar_process"; occupants: string[]; childTools: string[] }
  | { reason: "occupancy_unknown"; detail: string }
  | { reason: "workspace_handle_missing"; missing: string[] }
  | { reason: "identity_mismatch"; mismatches: IdentityMismatch[] }
  | { reason: "checkout_in_use"; attemptIds: string[] }
  | { reason: "unrelated_resource"; worktreePath: string; detail: string }
  | { reason: "checkout_unknown"; detail: string }
  | { reason: "writer_live"; agentName: string; agentStatus: string }
  | { reason: "writer_active"; state: string; checkout: string }
  | { reason: "host_unsupported"; host: string }
  | { reason: "not_accepted"; assignmentId: string; state: string }
  | { reason: "process_live"; state: string }
  | {
      reason: "approval_required";
      action: string;
      targets: string[];
      scope: string;
      requestRevision: string;
    }
  | { reason: "approval_revoked"; approvalId: string }
  | { reason: "preservation_failed"; name: string; path: string };

export type CleanupReport = {
  cleanupId: string | null;
  attemptId: string;
  assignmentId: string;
  kind: CleanupKind;
  state: CleanupState;
  requestRevision: string;
  worktreePath: string;
  branch: string;
  agentName: string;
  agentHost: string;
  workspaceId: string | null;
  paneId: string | null;
  evidence: EvidenceItem[];
  detail: string | null;
  settledAt: string | null;
};

export function reportOf(request: {
  context: CleanupContext;
  kind: CleanupKind;
  state: CleanupState;
  requestRevision: string;
  row: CleanupRow | null;
}): CleanupReport {
  const { dispatch } = request.context;
  const recorded = request.row === null ? null : cleanupRecordOf(request.row);

  return {
    cleanupId: recorded?.cleanupId ?? null,
    attemptId: request.context.attempt.id,
    assignmentId: request.context.assignment.id,
    kind: request.kind,
    state: request.state,
    requestRevision: request.requestRevision,
    worktreePath: dispatch.worktreePath,
    branch: dispatch.branch,
    agentName: dispatch.agentName,
    agentHost: dispatch.agentHost,
    workspaceId: dispatch.workspaceId,
    paneId: dispatch.paneId,
    evidence: recorded?.evidence ?? [],
    detail: recorded?.detail ?? null,
    settledAt: recorded?.settledAt ?? null,
  };
}

export type CleanupOverview = {
  status: "reported";
  stateVersion: number;
  cleanups: ReturnType<typeof cleanupRecordOf>[];
  holds: Array<{
    holdId: string;
    attemptId: string;
    reason: string;
    detail: string;
    state: string;
    revision: number;
    placedAt: string;
    releasedAt: string | null;
  }>;
};

/**
 * Reports every cleanup this crew recorded and every retention hold it still holds.
 * A pending, blocked, or failed cleanup survives the session that started it, so resource
 * ownership stays explicit after a restart. Writes nothing.
 */
export async function showCleanups(request: {
  projectRoot: string;
  attemptId: string | null;
}): Promise<CleanupOverview | StateFailure> {
  return readState(request.projectRoot, (db) => {
    const matches = (attemptId: string) =>
      request.attemptId === null || request.attemptId === attemptId;

    return {
      status: "reported" as const,
      stateVersion: STATE_VERSION,
      cleanups: allCleanups(db)
        .filter((row) => matches(row.attemptId))
        .map(cleanupRecordOf),
      holds: allRetentionHolds(db)
        .filter((row) => matches(row.attemptId))
        .map((row) => ({
          holdId: row.id,
          attemptId: row.attemptId,
          reason: row.reason,
          detail: row.detail,
          state: row.state,
          revision: row.revision,
          placedAt: row.placedAt,
          releasedAt: row.releasedAt,
        })),
    };
  });
}
