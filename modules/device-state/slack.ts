import { and, asc, desc, eq } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import { Err, Ok, type Result } from "unthrown";
import { checkHistory, transaction, type Db } from "./database.ts";
import { emptyRequest, insertEffects, type NewSlackEffect } from "./review-requests.ts";
import { projects, reviewRequests, slackEffects, slackWatches } from "./schema.ts";
import type { StateFailure } from "./failures.ts";

export type SlackEffectRow = typeof slackEffects.$inferSelect;
export type SlackWatchRow = typeof slackWatches.$inferSelect;
export type SlackCandidate = {
  repository: string;
  number: number;
  url: string;
  /** The message that posted the PR, and the thread that gets the replies. */
  threadTs: string;
};
export type IngestOutcome =
  | "recorded"
  | "attached"
  | "open"
  | "approved"
  | "assignment"
  | "skipped"
  | "unregistered";
/** The cursor state that one ingest expects and the state that it records. */
export type WatchState = Pick<SlackWatchRow, "cursor" | "latest" | "pending">;

function pending(db: Db) {
  return db
    .select({ effect: slackEffects, url: reviewRequests.url })
    .from(slackEffects)
    .innerJoin(reviewRequests, eq(reviewRequests.id, slackEffects.requestId))
    .where(eq(slackEffects.state, "pending"))
    .orderBy(asc(slackEffects.createdAt), asc(slackEffects.key))
    .all()
    .map((row) => ({ ...row.effect, url: row.url }));
}

/** The cursor of one channel, or null before its first watch, and every pending effect. */
export function readSlack(client: Database, channel: string) {
  return transaction(client, false, () =>
    checkHistory(client).map((db) => ({
      watch: db.select().from(slackWatches).where(eq(slackWatches.channel, channel)).get() ?? null,
      effects: pending(db),
    })),
  );
}

/**
 * Records the start cursor of a channel on its first watch, so a new session resumes from the
 * database alone. A recorded cursor stays.
 */
export function startSlackWatch(client: Database, channel: string, start: string) {
  // Stryker disable next-line BooleanLiteral: equivalent: every path writes, so a deferred begin reaches the same writer reservation before any result
  return transaction(client, true, () =>
    checkHistory(client).map((db) => {
      db.insert(slackWatches)
        .values({ channel, cursor: start, readAt: null, latest: null, pending: null })
        .onConflictDoNothing()
        .run();
      return undefined;
    }),
  );
}

function decideCandidate(db: Db, candidate: SlackCandidate): IngestOutcome {
  const registered = db
    .select({ repository: projects.repository })
    .from(projects)
    .where(eq(projects.repository, candidate.repository))
    .get();
  if (registered === undefined) return "unregistered";
  const latest = db
    .select()
    .from(reviewRequests)
    .where(
      and(
        eq(reviewRequests.repository, candidate.repository),
        eq(reviewRequests.number, candidate.number),
      ),
    )
    .orderBy(desc(reviewRequests.requestedAt))
    .get();
  if (latest === undefined) return "recorded";
  if (latest.state === "skipped") return "skipped";
  if (latest.state === "closed") return "recorded";
  if (latest.slackTs !== null) return "open";
  // An assignment review reports to its PR owner, not to Slack.
  if (latest.origin === "assignment") return "assignment";
  // An approved request gets no reply until a renewed request, so it takes no thread.
  return latest.state === "approved" ? "approved" : "attached";
}

function applyCandidate(
  db: Db,
  input: { channel: string; candidate: SlackCandidate; start: NewSlackEffect[] },
  outcome: IngestOutcome,
) {
  const { candidate, channel } = input;
  const slack = { slackChannel: channel, slackTs: candidate.threadTs };
  if (outcome === "recorded") {
    const id = crypto.randomUUID();
    db.insert(reviewRequests)
      .values({
        ...emptyRequest(),
        ...slack,
        id,
        repository: candidate.repository,
        number: candidate.number,
        url: candidate.url,
        origin: "slack",
        state: "queued",
        requestedAt: new Date().toISOString(),
      })
      .run();
    insertEffects(db, { id, ...slack }, input.start);
    return id;
  }
  const open = db
    .select({ id: reviewRequests.id })
    .from(reviewRequests)
    .where(
      and(
        eq(reviewRequests.repository, candidate.repository),
        eq(reviewRequests.number, candidate.number),
      ),
    )
    .orderBy(desc(reviewRequests.requestedAt))
    .get();
  // Stryker disable next-line ConditionalExpression: equivalent: an attached outcome comes from an existing latest request, which this query finds again
  if (outcome === "attached" && open !== undefined) {
    db.update(reviewRequests).set(slack).where(eq(reviewRequests.id, open.id)).run();
    insertEffects(db, { id: open.id, ...slack }, input.start);
  }
  return open?.id ?? null;
}

/**
 * Records the eligible PRs of one channel read and moves its cursor, in one write transaction.
 * A skipped PR stays skipped. An open request without a Slack thread gets this thread. A cursor
 * that another ingest moved first refuses, so two ingests never record the same read twice.
 */
export function ingestSlack(
  client: Database,
  input: {
    channel: string;
    from: WatchState;
    /** With `paging`, the next read is due at once for the older messages. */
    to: WatchState & { paging: boolean };
    candidates: SlackCandidate[];
    start: NewSlackEffect[];
  },
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap(
      (
        db,
      ): Result<
        { candidate: SlackCandidate; outcome: IngestOutcome; id: string | null }[],
        StateFailure | { reason: string; detail: string }
      > => {
        const watch = db
          .select()
          .from(slackWatches)
          .where(eq(slackWatches.channel, input.channel))
          .get();
        if (
          watch === undefined ||
          watch.cursor !== input.from.cursor ||
          watch.latest !== input.from.latest ||
          watch.pending !== input.from.pending
        )
          return Err({
            reason: "slack_cursor_moved",
            detail: `Another ingest moved the cursor of ${input.channel}. Run operator review wait for the next read. Nothing was recorded.`,
          });
        const outcomes = input.candidates.map((candidate) => {
          const outcome = decideCandidate(db, candidate);
          const id = applyCandidate(
            db,
            { channel: input.channel, candidate, start: input.start },
            outcome,
          );
          return { candidate, outcome, id };
        });
        db.update(slackWatches)
          .set({
            cursor: input.to.cursor,
            latest: input.to.latest,
            pending: input.to.pending,
            readAt: input.to.paging ? null : new Date().toISOString(),
          })
          .where(eq(slackWatches.channel, input.channel))
          .run();
        return Ok(outcomes);
      },
    ),
  );
}

/**
 * Records the agent's acknowledgement of one effect. A refused send keeps the effect pending
 * with its failure. A repeated acknowledgement changes nothing.
 */
export function acknowledgeSlackEffect(
  client: Database,
  id: string,
  /** Decides from the recorded effect, because the result must prove that exact effect. */
  decide: (
    effect: SlackEffectRow,
  ) => { kind: "done"; slackTs: string | null } | { kind: "failed"; detail: string },
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) => {
      const effect = db.select().from(slackEffects).where(eq(slackEffects.id, id)).get();
      if (effect === undefined)
        return Err({
          reason: "slack_effect_missing",
          detail: `No Slack effect has the id ${id}. Read operator review wait for the pending effects.`,
        });
      if (effect.state === "done") return Ok({ effect, changed: false });
      const outcome = decide(effect);
      db.update(slackEffects)
        .set(
          outcome.kind === "done"
            ? {
                state: "done",
                doneAt: new Date().toISOString(),
                slackTs: outcome.slackTs,
                failure: null,
              }
            : { failure: outcome.detail },
        )
        .where(eq(slackEffects.id, id))
        .run();
      return Ok({
        effect: db.select().from(slackEffects).where(eq(slackEffects.id, id)).get() ?? effect,
        changed: true,
      });
    }),
  );
}
