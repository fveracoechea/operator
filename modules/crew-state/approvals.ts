import { eq } from "drizzle-orm";
import type { CrewReader, CrewWriter } from "./database.ts";
import type { ApprovalCheck, ApprovalInput } from "./question-input.ts";
import { approvals } from "./schema.ts";

export type ApprovalRow = typeof approvals.$inferSelect;

export type ApprovalRecord = {
  approvalId: string;
  action: string;
  targets: string[];
  scope: string;
  requestRevision: string;
  state: string;
  revision: number;
  grantedAt: string;
  revokedAt: string | null;
};

/** The targets of one approval, in the order the grant fixed them. */
function targetsOf(row: ApprovalRow): string[] {
  return JSON.parse(row.targets);
}

export function recordOf(row: ApprovalRow): ApprovalRecord {
  return {
    approvalId: row.id,
    action: row.action,
    targets: targetsOf(row),
    scope: row.scope,
    requestRevision: row.requestRevision,
    state: row.state,
    revision: row.revision,
    grantedAt: row.grantedAt,
    revokedAt: row.revokedAt,
  };
}

export function readApproval(db: CrewReader, approvalId: string): ApprovalRow | null {
  return db.select().from(approvals).where(eq(approvals.id, approvalId)).all()[0] ?? null;
}

export type Coverage =
  | { status: "covers" }
  | { status: "revoked" }
  | { status: "mismatch"; field: "action" | "targets" | "scope" | "request-revision" };

/**
 * Decides whether one recorded approval covers one exact action.
 * The action, the scope, and the request revision must be the same words, and the approval must
 * name every target of the action. A broader grant therefore covers a narrower action, and an
 * approval that names fewer targets never covers more of them.
 */
export function approvalCovers(row: ApprovalRow, check: ApprovalCheck): Coverage {
  if (row.action !== check.action) {
    return { status: "mismatch", field: "action" };
  }
  if (row.scope !== check.scope) {
    return { status: "mismatch", field: "scope" };
  }
  if (row.requestRevision !== check.requestRevision) {
    return { status: "mismatch", field: "request-revision" };
  }

  const targets = targetsOf(row);
  if (!check.targets.every((target) => targets.includes(target))) {
    return { status: "mismatch", field: "targets" };
  }

  return row.state === "granted" ? { status: "covers" } : { status: "revoked" };
}

export type ApprovalMatch =
  | { status: "matched"; approval: ApprovalRecord }
  | { status: "revoked"; approval: ApprovalRecord }
  | { status: "missing" };

/** Finds the recorded approval that covers one exact action, if this crew holds one. */
export function matchApproval(db: CrewReader, check: ApprovalCheck): ApprovalMatch {
  const covering = db
    .select()
    .from(approvals)
    .where(eq(approvals.action, check.action))
    .all()
    .map((row) => ({ row, coverage: approvalCovers(row, check) }))
    .filter((one) => one.coverage.status !== "mismatch");

  const granted = covering.find((one) => one.coverage.status === "covers");
  if (granted !== undefined) {
    return { status: "matched", approval: recordOf(granted.row) };
  }

  const revoked = covering[0];
  return revoked === undefined
    ? { status: "missing" }
    : { status: "revoked", approval: recordOf(revoked.row) };
}

export type GrantResult = { status: "granted"; approval: ApprovalRecord };

export function grantApproval(
  db: CrewWriter,
  request: { approvalId: string; input: ApprovalInput; now: string },
): GrantResult {
  const row: ApprovalRow = {
    id: request.approvalId,
    action: request.input.action,
    targets: JSON.stringify(request.input.targets),
    scope: request.input.scope,
    requestRevision: request.input.requestRevision,
    exactText: request.input.exactText,
    state: "granted",
    revision: 1,
    grantedAt: request.now,
    revokedAt: null,
  };
  db.insert(approvals).values(row).run();

  return { status: "granted", approval: recordOf(row) };
}

export type RevokeResult =
  | { status: "revoked"; approval: ApprovalRecord }
  | { status: "unknown-approval"; approvalId: string }
  | { status: "already-revoked"; approval: ApprovalRecord }
  | { status: "stale-revision"; approvalId: string; recordedRevision: number };

export function revokeApproval(
  db: CrewWriter,
  request: { approvalId: string; revision: number; now: string },
): RevokeResult {
  const row = readApproval(db, request.approvalId);
  if (row === null) {
    return { status: "unknown-approval", approvalId: request.approvalId };
  }
  if (row.state === "revoked") {
    return { status: "already-revoked", approval: recordOf(row) };
  }
  if (row.revision !== request.revision) {
    return {
      status: "stale-revision",
      approvalId: row.id,
      recordedRevision: row.revision,
    };
  }

  const revision = row.revision + 1;
  db.update(approvals)
    .set({ state: "revoked", revision, revokedAt: request.now })
    .where(eq(approvals.id, row.id))
    .run();

  return {
    status: "revoked",
    approval: recordOf({ ...row, state: "revoked", revision, revokedAt: request.now }),
  };
}
