import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { CrewReader, CrewWriter } from "./database.ts";
import type { CleanupEffect } from "./dispatch.ts";
import { identityOf } from "./identity.ts";
import { cleanups, retentionHolds, workSources } from "./schema.ts";
import { readStored } from "./stored.ts";

/** The two cleanup outcomes. Each is recorded, retried, and recovered on its own. */
export const CLEANUP_KINDS = ["process_closure", "worktree_removal"] as const;

export type CleanupKind = (typeof CLEANUP_KINDS)[number];

/** The external effect each cleanup outcome performs. */
export const CLEANUP_OPERATION = {
  process_closure: "agent_stop",
  worktree_removal: "worktree_remove",
} as const satisfies Record<CleanupKind, CleanupEffect>;

export type CleanupState = "pending" | "blocked" | "failed" | "uncertain" | "done";

export type CleanupRow = typeof cleanups.$inferSelect;
export type RetentionHoldRow = typeof retentionHolds.$inferSelect;

const evidenceItemSchema = z.strictObject({
  name: z.string(),
  origin: z.enum(["worktree", "checkout"]),
  path: z.string(),
  storedPath: z.string(),
  contentIdentity: z.string(),
});

export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export function storedEvidence(stored: string): EvidenceItem[] {
  return readStored("cleanup evidence list", z.array(evidenceItemSchema), stored);
}

export type CleanupRecord = {
  cleanupId: string;
  attemptId: string;
  assignmentId: string;
  kind: CleanupKind;
  state: string;
  requestRevision: string;
  detail: string | null;
  evidence: EvidenceItem[];
  revision: number;
  startedAt: string;
  settledAt: string | null;
};

export function cleanupRecordOf(row: CleanupRow): CleanupRecord {
  return {
    cleanupId: row.id,
    attemptId: row.attemptId,
    assignmentId: row.assignmentId,
    kind: isCleanupKind(row.kind) ? row.kind : "process_closure",
    state: row.state,
    requestRevision: row.requestRevision,
    detail: row.detail,
    evidence: row.evidence === null ? [] : storedEvidence(row.evidence),
    revision: row.revision,
    startedAt: row.startedAt,
    settledAt: row.settledAt,
  };
}

export function isCleanupKind(kind: string): kind is CleanupKind {
  return CLEANUP_KINDS.some((one) => one === kind);
}

export function readCleanup(
  db: CrewReader,
  request: { attemptId: string; kind: CleanupKind },
): CleanupRow | null {
  return (
    db
      .select()
      .from(cleanups)
      .where(and(eq(cleanups.attemptId, request.attemptId), eq(cleanups.kind, request.kind)))
      .all()[0] ?? null
  );
}

export function allCleanups(db: CrewReader): CleanupRow[] {
  return db
    .select()
    .from(cleanups)
    .all()
    .toSorted((left, right) => left.startedAt.localeCompare(right.startedAt));
}

/** Writes one cleanup outcome, keeping the row it already holds for this attempt and kind. */
export function recordCleanup(
  db: CrewWriter,
  request: {
    cleanupId: string;
    attemptId: string;
    assignmentId: string;
    kind: CleanupKind;
    state: CleanupState;
    requestRevision: string;
    inspection: unknown;
    evidence: EvidenceItem[] | null;
    detail: string | null;
    now: string;
  },
): CleanupRow {
  const existing = readCleanup(db, { attemptId: request.attemptId, kind: request.kind });
  const settled = request.state === "done" || request.state === "failed";
  const row: CleanupRow = {
    id: existing?.id ?? request.cleanupId,
    attemptId: request.attemptId,
    assignmentId: request.assignmentId,
    kind: request.kind,
    state: request.state,
    requestRevision: request.requestRevision,
    inspection: request.inspection === null ? null : JSON.stringify(request.inspection),
    evidence:
      request.evidence === null ? (existing?.evidence ?? null) : JSON.stringify(request.evidence),
    detail: request.detail,
    revision: (existing?.revision ?? 0) + 1,
    startedAt: existing?.startedAt ?? request.now,
    settledAt: settled ? request.now : null,
  };

  if (existing === null) {
    db.insert(cleanups).values(row).run();
  } else {
    db.update(cleanups).set(row).where(eq(cleanups.id, existing.id)).run();
  }

  return row;
}

export function heldRetention(db: CrewReader, attemptId: string): RetentionHoldRow | null {
  return (
    db
      .select()
      .from(retentionHolds)
      .where(eq(retentionHolds.attemptId, attemptId))
      .all()
      .find((one) => one.state === "held") ?? null
  );
}

export function allRetentionHolds(db: CrewReader): RetentionHoldRow[] {
  return db
    .select()
    .from(retentionHolds)
    .all()
    .toSorted((left, right) => left.placedAt.localeCompare(right.placedAt));
}

/**
 * The revision of the workflow one approval was granted against.
 * It moves when the registered work changes and when the crew changes owner, so an approval
 * survives a restart and nothing else.
 */
export function workflowRevisionOf(db: CrewReader, ownershipRevision: number): string {
  const sources = db
    .select()
    .from(workSources)
    .all()
    .map((source) => ({ id: source.id, revision: source.revision }))
    .toSorted((left, right) => left.id.localeCompare(right.id));

  return identityOf({ ownershipRevision, sources });
}

/**
 * The revision of one cleanup request.
 * It names the workflow, the resources this cleanup would touch, and the checkout as it was
 * inspected, so a human edit after the grant leaves the approval covering a different request.
 */
export function cleanupRevisionOf(request: {
  workflowRevision: string;
  kind: CleanupKind;
  attemptId: string;
  assignmentId: string;
  worktreePath: string;
  branch: string;
  inspectionIdentity: string;
}): string {
  return identityOf(request);
}
