import { eq } from "drizzle-orm";
import { dirname } from "node:path";
import { z } from "zod";
import type { OperativeDispatch } from "../operative-dispatch/main.ts";
import { matchApproval } from "./approvals.ts";
import type { CrewReader, CrewWriter } from "./database.ts";
import { identityOf } from "./identity.ts";
import { outsideChanges } from "./schema.ts";
import { readStored } from "./stored.ts";
import type { SubmissionRow } from "./submission.ts";

export type OutsideScan = Awaited<ReturnType<typeof OperativeDispatch.scanOutside>>;

const place = z.enum(["worktree-parent", "checkout", "git-hooks", "git-config"]);

const reading = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("read"),
    value: z.array(z.strictObject({ place, path: z.string(), state: z.string() })),
  }),
  z.strictObject({ status: z.literal("unread"), detail: z.string() }),
]);

const scanSchema = z.strictObject({ parent: reading, checkout: reading });

export function storedScan(stored: string): OutsideScan {
  return readStored("outside scan", scanSchema, stored);
}

/**
 * The approval a person grants to keep one outside change that touches a security permission.
 * It names the exact path, the submission, and the change, so it never covers a later change.
 */
export const OUTSIDE_CHANGE_APPROVAL = "outside-change-keep";

export type OutsideChangeRow = typeof outsideChanges.$inferSelect;

type Change = Omit<OutsideChangeRow, "id" | "submissionId" | "recordedAt"> & {
  disposition: null;
  reason: null;
  evidence: null;
  approvalId: null;
  disposedAt: null;
};

const undecided = {
  disposition: null,
  reason: null,
  evidence: null,
  approvalId: null,
  disposedAt: null,
} as const;

type Part = "parent" | "checkout";

/**
 * Each place an outside scan reads: the scan part that holds it, so a removal is proven by the
 * part that found it, and whether a change there touches a security permission.
 */
const PLACES = new Map<string, { part: Part; security: boolean }>([
  ["worktree-parent", { part: "parent", security: false }],
  ["checkout", { part: "checkout", security: false }],
  ["git-hooks", { part: "checkout", security: true }],
  ["git-config", { part: "checkout", security: true }],
] satisfies Array<[z.infer<typeof place>, { part: Part; security: boolean }]>);

function placeOf(where: string): { part: Part; security: boolean } {
  return PLACES.get(where) ?? { part: "checkout", security: false };
}

/**
 * Every difference between the two snapshots of one attempt (ADR 0018).
 * A part that one of the scans could not read, or a "before" scan that was never recorded,
 * becomes one change that says so, because a scan that did not run never reports a pass.
 */
export function outsideChangesOf(request: {
  before: string | null;
  after: OutsideScan;
  worktreePath: string;
  projectRoot: string;
}): Change[] {
  const before = request.before === null ? null : storedScan(request.before);
  const parts: Array<{ part: Part; folder: string }> = [
    { part: "parent", folder: dirname(request.worktreePath) },
    { part: "checkout", folder: request.projectRoot },
  ];

  return parts.flatMap(({ part, folder }): Change[] => {
    const earlier = before?.[part] ?? null;
    const later = request.after[part];
    if (earlier === null || earlier.status === "unread" || later.status === "unread") {
      return [
        {
          place: part === "parent" ? "worktree-parent" : "checkout",
          path: folder,
          change: "unscanned",
          before: earlier?.status === "unread" ? earlier.detail : null,
          after:
            earlier === null
              ? "No scan was recorded when this attempt started."
              : later.status === "unread"
                ? later.detail
                : "The scan when this attempt started could not run.",
          // Nothing proves the hooks and the config unchanged, so the user decides it.
          security: part === "checkout" ? 1 : 0,
          ...undecided,
        },
      ];
    }

    const held = new Map(earlier.value.map((one) => [`${one.place}\0${one.path}`, one]));
    const found = new Map(later.value.map((one) => [`${one.place}\0${one.path}`, one]));
    const keys = [...new Set([...held.keys(), ...found.keys()])].toSorted();
    return keys.flatMap((key): Change[] => {
      const old = held.get(key);
      const now = found.get(key);
      if (old !== undefined && now !== undefined && old.state === now.state) {
        return [];
      }
      const entry = now ?? old;
      if (entry === undefined) {
        return [];
      }
      return [
        {
          place: entry.place,
          path: entry.path,
          change: old === undefined ? "added" : now === undefined ? "removed" : "changed",
          before: old?.state ?? null,
          after: now?.state ?? null,
          security: placeOf(entry.place).security ? 1 : 0,
          ...undecided,
        },
      ];
    });
  });
}

/** Records the outside changes of one submission. A change id also binds the approval for it. */
export function recordOutsideChanges(
  db: CrewWriter,
  request: { submissionId: string; changes: Change[]; now: string },
): void {
  for (const change of request.changes) {
    db.insert(outsideChanges)
      .values({
        ...change,
        id: identityOf({ submissionId: request.submissionId, ...change }).slice(0, 32),
        submissionId: request.submissionId,
        recordedAt: request.now,
      })
      .run();
  }
}

export function outsideChangesOfSubmission(
  db: CrewReader,
  submissionId: string,
): OutsideChangeRow[] {
  return db
    .select()
    .from(outsideChanges)
    .where(eq(outsideChanges.submissionId, submissionId))
    .all()
    .toSorted(
      (left, right) => left.place.localeCompare(right.place) || left.path.localeCompare(right.path),
    );
}

export function undisposedOutside(rows: OutsideChangeRow[]): OutsideChangeRow[] {
  return rows.filter((one) => one.disposition === null);
}

/** What one outside change is, as a reader sees it. */
export function outsideRecordOf(row: OutsideChangeRow) {
  return {
    changeId: row.id,
    place: row.place,
    path: row.path,
    change: row.change,
    before: row.before,
    after: row.after,
    security: row.security === 1,
    disposition: row.disposition,
    reason: row.reason,
    evidence: row.evidence,
    approvalId: row.approvalId,
  };
}

const text = z.string().min(1);

export const outsideDispositionInputSchema = z.strictObject({
  dispositions: z
    .array(
      z.discriminatedUnion("disposition", [
        z.strictObject({
          changeId: text,
          disposition: z.literal("explained"),
          reason: text,
          evidence: text,
        }),
        // A removal carries no words of its own, because only a new scan proves it.
        z.strictObject({ changeId: text, disposition: z.literal("removed") }),
      ]),
    )
    .min(1),
});

export type OutsideDispositionInput = z.infer<typeof outsideDispositionInputSchema>;

/** The approval a person must grant before a security change is kept. */
function approvalFor(row: OutsideChangeRow) {
  return {
    action: OUTSIDE_CHANGE_APPROVAL,
    targets: [row.path],
    scope: row.submissionId,
    requestRevision: row.id,
  };
}

export type OutsideDisposeOutcome =
  | {
      status: "disposed";
      submissionId: string;
      disposed: Array<{ changeId: string; disposition: string }>;
      outstanding: string[];
    }
  | { status: "unknown-submission"; submissionId: string }
  | { status: "submission-settled"; submissionId: string; state: string }
  | { status: "unknown-outside-change"; submissionId: string; changeIds: string[] }
  | {
      status: "outside-dispose-refused";
      submissionId: string;
      // A new scan still finds each of these as it was found at submit, or it could not run.
      notRemoved: Array<{ changeId: string; path: string; found: string | null }>;
      // Each of these touches a security permission, so only the user keeps it.
      approvalMissing: Array<{ changeId: string; approval: ReturnType<typeof approvalFor> }>;
    };

/** The current state of one entry in a new scan, or why the scan cannot prove anything. */
function rescanned(
  row: OutsideChangeRow,
  scan: OutsideScan | null,
): { proven: boolean; found: string | null } {
  const part = scan?.[placeOf(row.place).part];
  if (row.change === "unscanned" || part === undefined || part.status === "unread") {
    return { proven: false, found: part?.status === "unread" ? part.detail : null };
  }
  const now = part.value.find((one) => one.place === row.place && one.path === row.path);
  const found = now?.state ?? null;
  return { proven: found === row.before, found };
}

/**
 * Records what the Operator decided about each outside change of one submission.
 * Operator never deletes one: the user does, and `removed` passes only when a new scan finds
 * the entry as it was before the attempt. A change that touches a security permission is kept
 * only under an approval of the user (ADR 0006).
 */
export function disposeOutsideChanges(
  db: CrewWriter,
  request: {
    submission: SubmissionRow;
    input: OutsideDispositionInput;
    scan: OutsideScan | null;
    now: string;
  },
): OutsideDisposeOutcome {
  const { submission } = request;
  if (submission.state !== "awaiting-review") {
    return { status: "submission-settled", submissionId: submission.id, state: submission.state };
  }

  const held = new Map(outsideChangesOfSubmission(db, submission.id).map((one) => [one.id, one]));
  const unknown = request.input.dispositions
    .map((one) => one.changeId)
    .filter((id) => !held.has(id));
  if (unknown.length > 0) {
    return { status: "unknown-outside-change", submissionId: submission.id, changeIds: unknown };
  }

  const notRemoved: Extract<OutsideDisposeOutcome, { notRemoved: unknown }>["notRemoved"] = [];
  const approvalMissing: Extract<
    OutsideDisposeOutcome,
    { approvalMissing: unknown }
  >["approvalMissing"] = [];
  const approvals = new Map<string, string>();
  for (const one of request.input.dispositions) {
    const row = held.get(one.changeId);
    if (row === undefined) {
      continue;
    }
    if (one.disposition === "removed") {
      const proof = rescanned(row, request.scan);
      if (!proof.proven) {
        notRemoved.push({ changeId: row.id, path: row.path, found: proof.found });
      }
      continue;
    }
    if (row.security === 1) {
      const match = matchApproval(db, approvalFor(row));
      if (match.status === "matched") {
        approvals.set(row.id, match.approval.approvalId);
      } else {
        approvalMissing.push({ changeId: row.id, approval: approvalFor(row) });
      }
    }
  }
  if (notRemoved.length > 0 || approvalMissing.length > 0) {
    return {
      status: "outside-dispose-refused",
      submissionId: submission.id,
      notRemoved,
      approvalMissing,
    };
  }

  for (const one of request.input.dispositions) {
    db.update(outsideChanges)
      .set({
        disposition: one.disposition,
        reason: one.disposition === "explained" ? one.reason : null,
        evidence: one.disposition === "explained" ? one.evidence : null,
        approvalId: approvals.get(one.changeId) ?? null,
        disposedAt: request.now,
      })
      .where(eq(outsideChanges.id, one.changeId))
      .run();
  }

  return {
    status: "disposed",
    submissionId: submission.id,
    disposed: request.input.dispositions.map((one) => ({
      changeId: one.changeId,
      disposition: one.disposition,
    })),
    outstanding: undisposedOutside(outsideChangesOfSubmission(db, submission.id)).map(
      (one) => one.id,
    ),
  };
}
