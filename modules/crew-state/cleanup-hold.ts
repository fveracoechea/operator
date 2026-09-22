import { eq } from "drizzle-orm";
import { z } from "zod";
import { readAttempt } from "./attempt.ts";
import { heldRetention, type RetentionHoldRow } from "./cleanup.ts";
import type { CrewWriter } from "./database.ts";
import { retentionHolds } from "./schema.ts";

const text = z.string().min(1);

/** One explicit decision to keep an Operative's resources, with the reason a person gave. */
export const holdInputSchema = z.strictObject({ reason: text, detail: text });

export type HoldInput = z.infer<typeof holdInputSchema>;

export type HoldRecord = {
  holdId: string;
  attemptId: string;
  reason: string;
  detail: string;
  state: string;
  revision: number;
  placedAt: string;
  releasedAt: string | null;
};

export function holdRecordOf(row: RetentionHoldRow): HoldRecord {
  return {
    holdId: row.id,
    attemptId: row.attemptId,
    reason: row.reason,
    detail: row.detail,
    state: row.state,
    revision: row.revision,
    placedAt: row.placedAt,
    releasedAt: row.releasedAt,
  };
}

export type HoldResult =
  | { status: "held"; hold: HoldRecord }
  | { status: "already-held"; hold: HoldRecord }
  | { status: "unknown-attempt"; attemptId: string };

/** Places one retention hold. A held attempt keeps every resource until a person releases it. */
export function placeHold(
  db: CrewWriter,
  request: { holdId: string; attemptId: string; input: HoldInput; now: string },
): HoldResult {
  if (readAttempt(db, request.attemptId) === null) {
    return { status: "unknown-attempt", attemptId: request.attemptId };
  }

  const existing = heldRetention(db, request.attemptId);
  if (existing !== null) {
    return { status: "already-held", hold: holdRecordOf(existing) };
  }

  const row: RetentionHoldRow = {
    id: request.holdId,
    attemptId: request.attemptId,
    reason: request.input.reason,
    detail: request.input.detail,
    state: "held",
    revision: 1,
    placedAt: request.now,
    releasedAt: null,
  };
  db.insert(retentionHolds).values(row).run();

  return { status: "held", hold: holdRecordOf(row) };
}

export type ReleaseResult =
  | { status: "released"; hold: HoldRecord }
  | { status: "no-hold"; attemptId: string }
  | { status: "stale-revision"; holdId: string; recordedRevision: number };

/** Ends one retention hold. Cleanup becomes possible again, and every other gate still applies. */
export function releaseHold(
  db: CrewWriter,
  request: { attemptId: string; revision: number; now: string },
): ReleaseResult {
  const existing = heldRetention(db, request.attemptId);
  if (existing === null) {
    return { status: "no-hold", attemptId: request.attemptId };
  }
  if (existing.revision !== request.revision) {
    return {
      status: "stale-revision",
      holdId: existing.id,
      recordedRevision: existing.revision,
    };
  }

  const revision = existing.revision + 1;
  db.update(retentionHolds)
    .set({ state: "released", revision, releasedAt: request.now })
    .where(eq(retentionHolds.id, existing.id))
    .run();

  return {
    status: "released",
    hold: holdRecordOf({ ...existing, state: "released", revision, releasedAt: request.now }),
  };
}
