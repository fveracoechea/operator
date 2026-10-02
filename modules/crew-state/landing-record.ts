import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { CrewReader } from "./database.ts";
import { landings } from "./schema.ts";
import { readStored } from "./stored.ts";

/*
 * The recorded landings of the crew state, read with no Git and no integration branch row, so
 * every reader of a landing, the dispatch start among them, can depend on this file alone.
 */

export type LandingRow = typeof landings.$inferSelect;

/**
 * The plan of one rewrite, as its intent records it (ADR 0020). It names the landing that the
 * correction replaces, each later landing that lands again with its new commit, and each later
 * landing that is taken out, so recovery and the record read the same move. A take-out names no
 * correction: it records the registration plan revision that recorded the withdrawals it is bound
 * to, and each other withdrawn landing that it removes with the replaced one (D5). A rewrite that
 * an earlier release recorded carries no take-out part.
 */
const rewriteRecordSchema = z.strictObject({
  replaces: z.string(),
  replacedCommit: z.string(),
  relanded: z.array(
    z.strictObject({
      landingId: z.string(),
      assignmentId: z.string(),
      from: z.string(),
      to: z.string(),
      parent: z.string(),
    }),
  ),
  takenOut: z.array(
    z.strictObject({
      landingId: z.string(),
      assignmentId: z.string(),
      commit: z.string(),
      cause: z.enum(["conflict", "patch-changed", "gate", "dependency"]),
    }),
  ),
  takeOut: z
    .strictObject({
      planRevision: z.string(),
      removed: z.array(
        z.strictObject({ landingId: z.string(), assignmentId: z.string(), commit: z.string() }),
      ),
    })
    .nullable()
    .default(null),
});

export type RewriteRecord = z.infer<typeof rewriteRecordSchema>;

/** The landing that carries the accepted result of one assignment now, or null. */
export function currentLandingOf(db: CrewReader, assignmentId: string): LandingRow | null {
  return (
    db
      .select()
      .from(landings)
      .where(and(eq(landings.assignmentId, assignmentId), eq(landings.state, "landed")))
      .all()
      .toSorted((left, right) =>
        (left.landedAt ?? left.createdAt).localeCompare(right.landedAt ?? right.createdAt),
      )
      .at(-1) ?? null
  );
}

/** Every landing of one source that the branch carries now, in no order. */
export function landedOfSource(db: CrewReader, sourceId: string): LandingRow[] {
  return db
    .select()
    .from(landings)
    .where(and(eq(landings.sourceId, sourceId), eq(landings.state, "landed")))
    .all();
}

export function rewriteOf(landing: LandingRow): RewriteRecord | null {
  return landing.rewrite === null
    ? null
    : readStored("rewrite plan", rewriteRecordSchema, landing.rewrite);
}

/**
 * True when one open intent moves or rebuilds the commit of one assignment: its own landing, or
 * a rewrite that replaces, lands again, or takes out its commit.
 */
export function intentTouches(intent: LandingRow, assignmentId: string): boolean {
  if (intent.assignmentId === assignmentId) {
    return true;
  }
  const rewrite = rewriteOf(intent);
  return (
    rewrite !== null &&
    [...rewrite.relanded, ...rewrite.takenOut, ...(rewrite.takeOut?.removed ?? [])].some(
      (one) => one.assignmentId === assignmentId,
    )
  );
}

/** The landing of one source whose move has no recorded outcome, or null. */
export function intendedLandingOf(db: CrewReader, sourceId: string): LandingRow | null {
  return (
    db
      .select()
      .from(landings)
      .where(and(eq(landings.sourceId, sourceId), eq(landings.state, "intended")))
      .all()[0] ?? null
  );
}

/**
 * The landing that an earlier submission of one assignment holds on the branch, or null. A
 * submission of an assignment that already landed is a correction, so it takes the place of
 * that landing through a rewrite (ADR 0020).
 */
export function replacedLandingOf(
  db: CrewReader,
  request: { assignmentId: string; submissionId: string },
): LandingRow | null {
  const current = currentLandingOf(db, request.assignmentId);
  return current === null || current.submissionId === request.submissionId ? null : current;
}

/** The recorded landing of one submission, or null when it never landed. */
export function landingOfSubmission(db: CrewReader, submissionId: string): LandingRow | null {
  return (
    db
      .select()
      .from(landings)
      .where(and(eq(landings.submissionId, submissionId), eq(landings.state, "landed")))
      .all()[0] ?? null
  );
}
