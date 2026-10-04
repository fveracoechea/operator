import { eq } from "drizzle-orm";
import type { CrewReader, CrewWriter } from "./database.ts";
import { type ApprovalCheck, type ApprovalInput, approvalTargetsSchema } from "./approval-input.ts";
import { readState, type StateFailure } from "./operations.ts";
import { approvals, integrationRebases } from "./schema.ts";
import { publicationsOf } from "./stack-records.ts";
import { readStored } from "./stored.ts";

/*
 * The approval machine (ADR 0023). A person grants one approval for one exact action, and only
 * a person revokes it. The row records `granted` or `revoked`. "Used" is never recorded: a
 * granted approval is used once a stack publication or a rebase records the plan revision it
 * binds. So the coordination order offers only the grants that no record used yet.
 */

/** The approval action that covers one stack publication (ADR 0022, decision 9). */
export const PUBLISH_ACTION = "publish";

/** The approval action that covers one rebase onto a new base (ADR 0022, decision 25). */
export const REBASE_ACTION = "integration-rebase";

/** The approval action that covers one recall (ADR 0022, decision 23). */
export const RECALL_ACTION = "stack-recall";

export type ApprovalRow = typeof approvals.$inferSelect;

/** The states that the `approvals.state` column records. */
export type ApprovalState = "granted" | "revoked";

/** One approval as a reader sees it: not recorded, recorded, or granted and used by a record. */
export type ApprovalStatus = "none" | ApprovalState | "used";

export type ApprovalEvent =
  | { kind: "grant" }
  | { kind: "revoke"; revision: number }
  | { kind: "use" };

/** The refusals of each event. An event on an approval that is not recorded is refused by the read. */
type ApprovalRefusal = {
  grant: never;
  revoke: "already-revoked" | "stale-revision";
  use: "approval-required";
};

type Entry<K extends ApprovalEvent["kind"]> = {
  guards: Array<{
    refused: ApprovalRefusal[K];
    when: (
      approval: { status: ApprovalStatus; revision: number | null },
      event: ApprovalEvent,
    ) => boolean;
  }>;
  next: ApprovalStatus;
};

/**
 * The transition table of an approval: for each event, the guards in order and the next status.
 * A plan revision binds one exact plan, so a repeat of a used plan uses its grant again.
 */
const APPROVAL_TABLE: { [K in ApprovalEvent["kind"]]: Entry<K> } = {
  grant: { guards: [], next: "granted" },
  revoke: {
    guards: [
      { refused: "already-revoked", when: ({ status }) => status === "revoked" },
      {
        refused: "stale-revision",
        when: ({ revision }, event) => event.kind === "revoke" && event.revision !== revision,
      },
    ],
    next: "revoked",
  },
  use: {
    guards: [
      {
        refused: "approval-required",
        when: ({ status }) => status === "none" || status === "revoked",
      },
    ],
    next: "used",
  },
};

export const Approval = {
  /** Decides one event on one approval. It is pure: the caller reads the status and revision. */
  decide<K extends ApprovalEvent["kind"]>(
    approval: { status: ApprovalStatus; revision: number | null },
    event: ApprovalEvent & { kind: K },
  ): { next: ApprovalStatus } | { refused: ApprovalRefusal[K] } {
    const entry: Entry<K> = APPROVAL_TABLE[event.kind];
    const failed = entry.guards.find((guard) => guard.when(approval, event));
    return failed === undefined ? { next: entry.next } : { refused: failed.refused };
  },
};

/**
 * The plan revisions that the records of one scope used. A stack publication and a rebase each
 * record the plan revision of their approval. Other actions record none, so they are never used.
 */
function usedRevisions(db: CrewReader, action: string, scope: string): Set<string> {
  switch (action) {
    case PUBLISH_ACTION:
      return new Set(publicationsOf(db, scope).map((one) => one.planRevision));
    case REBASE_ACTION:
      return new Set(
        db
          .select()
          .from(integrationRebases)
          .where(eq(integrationRebases.sourceId, scope))
          .all()
          .map((one) => one.planRevision),
      );
    default:
      return new Set();
  }
}

/** The status of one recorded approval, with "used" read from the records of its scope. */
function statusOf(
  db: CrewReader,
  row: Pick<ApprovalRow, "state" | "action" | "scope" | "requestRevision">,
): ApprovalStatus {
  if (row.state === "revoked") {
    return "revoked";
  }
  return usedRevisions(db, row.action, row.scope).has(row.requestRevision) ? "used" : "granted";
}

/**
 * The granted approvals of one action and scope that no record used yet, in recorded order. The
 * coordination order offers one of them as the next action to run.
 */
export function grantedApprovalsOf(
  db: CrewReader,
  action: string,
  scope: string,
): ApprovalRecord[] {
  return db
    .select()
    .from(approvals)
    .where(eq(approvals.action, action))
    .all()
    .filter((row) => row.scope === scope && statusOf(db, row) === "granted")
    .map(approvalRecordOf);
}

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
  return readStored("approval target list", approvalTargetsSchema, row.targets);
}

export function approvalRecordOf(row: ApprovalRow): ApprovalRecord {
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
    return { status: "matched", approval: approvalRecordOf(granted.row) };
  }

  const revoked = covering[0];
  return revoked === undefined
    ? { status: "missing" }
    : { status: "revoked", approval: approvalRecordOf(revoked.row) };
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
    // A grant has no guard: it records a new approval in the first state of the table.
    state: APPROVAL_TABLE.grant.next,
    revision: 1,
    grantedAt: request.now,
    revokedAt: null,
  };
  db.insert(approvals).values(row).run();

  return { status: "granted", approval: approvalRecordOf(row) };
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
  // Revoke reads only the recorded state, so a used grant is revoked like any other one.
  const decided = Approval.decide(
    { status: row.state === "revoked" ? "revoked" : "granted", revision: row.revision },
    { kind: "revoke", revision: request.revision },
  );
  if ("refused" in decided) {
    return decided.refused === "already-revoked"
      ? { status: "already-revoked", approval: approvalRecordOf(row) }
      : { status: "stale-revision", approvalId: row.id, recordedRevision: row.revision };
  }

  const revision = row.revision + 1;
  db.update(approvals)
    .set({ state: "revoked", revision, revokedAt: request.now })
    .where(eq(approvals.id, row.id))
    .run();

  return {
    status: "revoked",
    approval: approvalRecordOf({ ...row, state: "revoked", revision, revokedAt: request.now }),
  };
}

/** One plan preview as the approval reads it. A plan with no revision is not ready to apply. */
type PlanPreview = {
  refusals?: readonly unknown[];
  planRevision: string | null;
  approval: ApprovalCheck | null;
  planPath: string;
};

/** The preview of a plan that has a revision: each preview type is ready on this variant. */
type Ready<Preview extends PlanPreview> = Extract<Preview, { planRevision: string }>;

export type ApprovedPlan<Preview extends PlanPreview> =
  | { status: "plan-revision-changed"; stated: string; planned: string | null; planPath: string }
  | { status: "approval-required"; approval: ApprovalCheck; planPath: string }
  | { status: "approved"; approvalId: string; preview: Ready<Preview> }
  | StateFailure;

function isReady<Preview extends PlanPreview>(preview: Preview): preview is Ready<Preview> {
  return preview.planRevision !== null;
}

/**
 * Decides whether one previewed plan may be applied now, for publish, rebase, and recall: a plan
 * with a refusal is refused, a plan whose revision is not the stated one changed, and the plan of
 * the stated revision is used only under a granted approval that covers it. Only a preview that
 * holds refusals can be refused.
 */
export async function approvedPlan<Preview extends PlanPreview & { refusals: readonly unknown[] }>(
  projectRoot: string,
  preview: Preview,
  stated: string,
): Promise<ApprovedPlan<Preview> | { status: "refused" }>;
export async function approvedPlan<Preview extends PlanPreview>(
  projectRoot: string,
  preview: Preview,
  stated: string,
): Promise<ApprovedPlan<Preview>>;
export async function approvedPlan<Preview extends PlanPreview>(
  projectRoot: string,
  preview: Preview,
  stated: string,
): Promise<ApprovedPlan<Preview> | { status: "refused" }> {
  if ((preview.refusals ?? []).length > 0) {
    return { status: "refused" };
  }
  const { approval, planPath } = preview;
  if (!isReady(preview) || preview.planRevision !== stated || approval === null) {
    return { status: "plan-revision-changed", stated, planned: preview.planRevision, planPath };
  }
  const read = await readState(projectRoot, (db) => {
    const match = matchApproval(db, approval);
    return match.status === "missing"
      ? { status: "none" as const, revision: null, approvalId: null }
      : {
          status: statusOf(db, match.approval),
          revision: match.approval.revision,
          approvalId: match.approval.approvalId,
        };
  });
  if ("path" in read) {
    return read;
  }
  const decided = Approval.decide(read, { kind: "use" });
  return "refused" in decided || read.approvalId === null
    ? { status: "approval-required", approval, planPath }
    : { status: "approved", approvalId: read.approvalId, preview };
}
