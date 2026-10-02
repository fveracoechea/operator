import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { approvalRecordOf } from "./approvals.ts";
import type { CrewReader } from "./database.ts";
import { identityOf } from "./identity.ts";
import { assignments, attempts, approvals } from "./schema.ts";
import { recordedLanding } from "./submission.ts";
import { storedPermissions } from "./work-input.ts";
import {
  overlappingPaths,
  overlapsCommand,
  WRITE_PATHS_GRANT_ACTION,
  writePathRefusal,
} from "./write-paths.ts";

type AssignmentRow = typeof assignments.$inferSelect;

/**
 * The request revision of a grant: the identity of the write paths as registered.
 * It does not move with the assignment revision, so the grant covers every attempt and every
 * rework cycle, and it moves when the registered paths change, so the grant stops applying.
 */
function writePathsRevision(registered: string[]): string {
  return identityOf({ writePaths: registered });
}

/**
 * Which production assignments hold their write paths now. Work holds them from its first claim
 * until it reaches accepted completion, and again after it leaves accepted completion. A
 * withdrawal ends the hold, unless a commit of the work is still landed (ADR 0004).
 */
export function writePathHolders(db: CrewReader): (row: AssignmentRow) => boolean {
  const started = new Set(
    db
      .select()
      .from(attempts)
      .all()
      .map((one) => one.assignmentId),
  );
  return (row) =>
    row.kind === "production" &&
    started.has(row.id) &&
    row.state !== "accepted" &&
    (row.state !== "withdrawn" || recordedLanding(db, row.id) !== null);
}

/**
 * Reads the effective write paths of any assignment: its registered paths, then each target of
 * every current grant bound to them, in grant order. The approval check compares targets as
 * exact words, so the matcher reads the grant targets and not an approval check.
 */
export function writePathsReader(db: CrewReader): (row: AssignmentRow) => string[] {
  const grants = db
    .select()
    .from(approvals)
    .where(and(eq(approvals.action, WRITE_PATHS_GRANT_ACTION), eq(approvals.state, "granted")))
    .all()
    .toSorted((left, right) => left.grantedAt.localeCompare(right.grantedAt))
    .map(approvalRecordOf);

  return (row) => {
    const registered = storedPermissions(row.permissions).writePaths;
    const revision = writePathsRevision(registered);
    const granted = grants
      .filter((one) => one.scope === row.id && one.requestRevision === revision)
      .flatMap((one) => one.targets);
    return [...new Set([...registered, ...granted])];
  };
}

export function effectiveWritePaths(db: CrewReader, row: AssignmentRow): string[] {
  return writePathsReader(db)(row);
}

/** The paths a person is asked to grant. Each one must already be in its canonical form. */
export const grantRequestInputSchema = z.strictObject({
  paths: z
    .array(
      z.string().superRefine((path, context) => {
        const refusal = writePathRefusal(path);
        if (refusal !== null) {
          context.addIssue({ code: "custom", message: refusal });
        }
      }),
    )
    .min(1),
});

/**
 * One started assignment of the same source whose held paths the grant would overlap.
 * The Operator reads this, so it gives the number of overlapping pairs and not the pairs.
 */
export type GrantOverlap = { assignmentId: string; sourceKey: string; pathPairCount: number };

export type WritePathsReport = {
  assignmentId: string;
  sourceId: string;
  sourceKey: string;
  registered: string[];
  effective: string[];
  // The exact approval that grants the asked paths, what it would overlap, and the command that
  // lists each pair after the grant. Null when no paths were asked.
  grant: {
    approval: { action: string; targets: string[]; scope: string; requestRevision: string };
    overlaps: GrantOverlap[];
    command: string;
  } | null;
};

export type WritePathsResult =
  | ({ status: "reported" } & WritePathsReport)
  | { status: "unknown-assignment"; assignmentId: string }
  | { status: "not-production"; assignmentId: string; kind: string };

/**
 * Reports the effective write paths of one production assignment, and, for asked paths, the
 * approval request that would grant them. It writes nothing. A grant that makes two started
 * assignments overlap stops neither of them, so the request names each one for the person.
 */
export function showWritePaths(
  db: CrewReader,
  request: { assignmentId: string; paths: string[] | null },
): WritePathsResult {
  const rows = db.select().from(assignments).all();
  const row = rows.find((one) => one.id === request.assignmentId);
  if (row === undefined) {
    return { status: "unknown-assignment", assignmentId: request.assignmentId };
  }
  if (row.kind !== "production") {
    return { status: "not-production", assignmentId: row.id, kind: row.kind };
  }

  const effectiveOf = writePathsReader(db);
  const registered = storedPermissions(row.permissions).writePaths;
  const report = {
    assignmentId: row.id,
    sourceId: row.sourceId,
    sourceKey: row.sourceKey,
    registered,
    effective: effectiveOf(row),
  };
  if (request.paths === null) {
    return { status: "reported", ...report, grant: null };
  }

  const holds = writePathHolders(db);
  const paths = request.paths;
  const overlaps = rows
    .filter((one) => one.id !== row.id && one.sourceId === row.sourceId && holds(one))
    .map((one) => ({
      assignmentId: one.id,
      sourceKey: one.sourceKey,
      pathPairCount: overlappingPaths(paths, effectiveOf(one)).length,
    }))
    .filter((one) => one.pathPairCount > 0)
    // A code-unit order, so the order never depends on the locale of the machine.
    .toSorted((left, right) => (left.assignmentId < right.assignmentId ? -1 : 1));

  return {
    status: "reported",
    ...report,
    grant: {
      approval: {
        action: WRITE_PATHS_GRANT_ACTION,
        targets: paths,
        scope: row.id,
        requestRevision: writePathsRevision(registered),
      },
      overlaps,
      command: overlapsCommand(row.sourceId),
    },
  };
}
