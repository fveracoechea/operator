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

/** The states of one retention hold. A held attempt keeps every resource. */
export type HoldState = "held" | "released";

/** The events that move one retention hold. */
export type HoldEvent = "hold" | "release";

/** What a hold or a release reads first. The caller gathers it, and the decision reads nothing. */
export type HoldFacts = {
  attemptId: string;
  attemptKnown: boolean;
  /** The hold this attempt holds now. */
  held: RetentionHoldRow | null;
  /** The hold revision a release states it inspected. */
  revision: number | null;
};

type HoldRefusal = Exclude<HoldResult, { status: "held" }>;
type ReleaseRefusal = Exclude<ReleaseResult, { status: "released" }>;
type RefusalOf = { hold: HoldRefusal; release: ReleaseRefusal };

type HoldEntry<E extends HoldEvent> = {
  guards: Array<(facts: HoldFacts) => RefusalOf[E] | null>;
  next: HoldState;
};

/** The transition table of a retention hold: the guards of each event in order, and its next state. */
const HOLD_TABLE: { [E in HoldEvent]: HoldEntry<E> } = {
  hold: {
    guards: [
      ({ attemptKnown, attemptId }) =>
        attemptKnown ? null : { status: "unknown-attempt", attemptId },
      ({ held }) => (held === null ? null : { status: "already-held", hold: holdRecordOf(held) }),
    ],
    next: "held",
  },
  release: {
    guards: [
      ({ held, attemptId }) => (held === null ? { status: "no-hold", attemptId } : null),
      ({ held, revision }) =>
        held === null || held.revision === revision
          ? null
          : { status: "stale-revision", holdId: held.id, recordedRevision: held.revision },
    ],
    next: "released",
  },
};

export const Retention = {
  /** Decides one hold or one release. It is pure: the caller reads the facts first. */
  decide<E extends HoldEvent>(
    event: E,
    facts: HoldFacts,
  ): { refused: RefusalOf[E] } | { next: HoldState } {
    const entry: HoldEntry<E> = HOLD_TABLE[event];
    for (const guard of entry.guards) {
      const refused = guard(facts);
      if (refused !== null) {
        return { refused };
      }
    }
    return { next: entry.next };
  },
};

/** Places one retention hold. A held attempt keeps every resource until a person releases it. */
export function placeHold(
  db: CrewWriter,
  request: { holdId: string; attemptId: string; input: HoldInput; now: string },
): HoldResult {
  const decision = Retention.decide("hold", {
    attemptId: request.attemptId,
    attemptKnown: readAttempt(db, request.attemptId) !== null,
    held: heldRetention(db, request.attemptId),
    revision: null,
  });
  if ("refused" in decision) {
    return decision.refused;
  }

  const row: RetentionHoldRow = {
    id: request.holdId,
    attemptId: request.attemptId,
    reason: request.input.reason,
    detail: request.input.detail,
    state: decision.next,
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
  const decision = Retention.decide("release", {
    attemptId: request.attemptId,
    attemptKnown: true,
    held: existing,
    revision: request.revision,
  });
  if ("refused" in decision) {
    return decision.refused;
  }
  if (existing === null) {
    throw new Error("A release passed its guards with no hold to end.");
  }

  const revision = existing.revision + 1;
  const state = decision.next;
  db.update(retentionHolds)
    .set({ state, revision, releasedAt: request.now })
    .where(eq(retentionHolds.id, existing.id))
    .run();

  return {
    status: "released",
    hold: holdRecordOf({ ...existing, state, revision, releasedAt: request.now }),
  };
}
