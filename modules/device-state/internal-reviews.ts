import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import { Err, Ok, type Result } from "unthrown";
import { checkHistory, transaction, type Db } from "./database.ts";
import { ownerGone } from "./leases.ts";
import { internalReviewRounds, internalReviews, launches, projects, sources } from "./schema.ts";
import type { StateFailure } from "./failures.ts";
import { activeOwner, type PullRequestFailure } from "./pull-requests.ts";

export type InternalReviewRow = typeof internalReviews.$inferSelect;
export type InternalReviewRoundRow = typeof internalReviewRounds.$inferSelect;
type LaunchRow = typeof launches.$inferSelect;
export type HandoffFailure =
  | StateFailure
  | { reason: "source_not_found" | "handoff_not_found" | "handoff_running"; detail: string };
type Claimed = {
  review: InternalReviewRow;
  implementer: LaunchRow;
  latest: LaunchRow;
  checkout: string;
};

function key(sourceId: string, assignment: string) {
  return and(eq(internalReviews.sourceId, sourceId), eq(internalReviews.assignment, assignment));
}

function latestLaunch(db: Db, sourceId: string, assignment: string) {
  return db
    .select()
    .from(launches)
    .where(and(eq(launches.sourceId, sourceId), eq(launches.assignment, assignment)))
    .all()
    .reduce<LaunchRow | undefined>(
      (latest, row) => (latest === undefined || row.attempt > latest.attempt ? row : latest),
      undefined,
    );
}

/**
 * A reserved launch after the implementer's ends a pending handoff in the reservation's write,
 * also when the SuperAgent dispatches the reviewer after a stopped handoff.
 */
export function finishHandoff(db: Db, sourceId: string, assignment: string) {
  db.update(internalReviews)
    .set({
      handoffState: "done",
      handoffDetail: null,
      updatedAt: new Date().toISOString(),
      ownerPid: null,
      leaseAt: null,
    })
    .where(
      and(key(sourceId, assignment), inArray(internalReviews.handoffState, ["pending", "failed"])),
    )
    .run();
}

/** The implementer's latest launch ended at the handoff and no other process holds it. */
export function handoffDispatchable(db: Db, latest: LaunchRow | undefined, now: number) {
  if (latest?.state !== "finished") return false;
  const review = db
    .select()
    .from(internalReviews)
    .where(key(latest.sourceId, latest.assignment))
    .get();
  return (
    review?.state === "reviewing" &&
    review.implementerLaunchId === latest.id &&
    review.handoffState !== "done" &&
    (review.ownerPid === process.pid || ownerGone(review, now))
  );
}

/**
 * One process at a time runs a handoff. The claim records this process and its lease, so a
 * second invocation refuses and a stopped one becomes visible in next actions. A finished
 * handoff is returned without a claim.
 */
export function claimHandoff(
  client: Database,
  repository: string,
  sourceId: string,
  assignment: string,
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db): Result<Claimed, HandoffFailure> => {
      const source = db
        .select()
        .from(sources)
        .where(and(eq(sources.id, sourceId), eq(sources.repository, repository)))
        .get();
      if (source === undefined)
        return Err({
          reason: "source_not_found",
          detail: "The source does not exist in this project.",
        });
      const recorded = db
        .select({ review: internalReviews, implementer: launches })
        .from(internalReviews)
        .innerJoin(launches, eq(launches.id, internalReviews.implementerLaunchId))
        .where(key(sourceId, assignment))
        .get();
      const latest = latestLaunch(db, sourceId, assignment);
      const project = db.select().from(projects).where(eq(projects.repository, repository)).get();
      // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent: a recorded review always has its implementer launch and project
      if (recorded === undefined || latest === undefined || project === undefined)
        return Err({
          reason: "handoff_not_found",
          detail: `Assignment ${assignment} has no internal review. Only the association of a draft PR records one. Nothing was changed.`,
        });
      const { review, implementer } = recorded;
      const facts = { implementer, latest, checkout: project.checkout };
      if (review.handoffState === "done") return Ok({ review, ...facts });
      // The association records its handoff process at start, so that process may take its own claim.
      if (review.ownerPid !== process.pid && !ownerGone(review, Date.now()))
        return Err({
          reason: "handoff_running",
          detail: `Process ${review.ownerPid} is still handing off assignment ${assignment}. Read operator next later. Nothing was changed.`,
        });
      const now = new Date().toISOString();
      const claimed = {
        ...review,
        handoffState: "pending",
        handoffDetail: null,
        ownerPid: process.pid,
        leaseAt: now,
        updatedAt: now,
      };
      db.update(internalReviews).set(claimed).where(key(sourceId, assignment)).run();
      return Ok({ review: claimed, ...facts });
    }),
  );
}

/**
 * Records the process that an association started for its handoff, so next shows it running
 * before that process claims it. A handoff that a process already claimed or ended stays.
 */
export function startHandoff(client: Database, sourceId: string, assignment: string, pid: number) {
  // Stryker disable next-line BooleanLiteral: equivalent: every path writes, so a deferred begin reaches the same writer reservation before any result
  return transaction(client, true, () =>
    checkHistory(client).map((db) => {
      db.update(internalReviews)
        .set({ ownerPid: pid, leaseAt: new Date().toISOString() })
        .where(
          and(
            key(sourceId, assignment),
            isNull(internalReviews.ownerPid),
            eq(internalReviews.handoffState, "pending"),
          ),
        )
        .run();
      return undefined;
    }),
  );
}

/** A handoff that stopped keeps its reason until a retry or a reviewer launch ends it. */
export function failHandoff(
  client: Database,
  sourceId: string,
  assignment: string,
  detail: string,
) {
  // Stryker disable next-line BooleanLiteral: equivalent: every path writes, so a deferred begin reaches the same writer reservation before any result
  return transaction(client, true, () =>
    checkHistory(client).map((db) => {
      db.update(internalReviews)
        .set({
          handoffState: "failed",
          handoffDetail: detail,
          updatedAt: new Date().toISOString(),
          ownerPid: null,
          leaseAt: null,
        })
        .where(
          and(
            key(sourceId, assignment),
            eq(internalReviews.handoffState, "pending"),
            eq(internalReviews.ownerPid, process.pid),
          ),
        )
        .run();
      return undefined;
    }),
  );
}

/** Renew the lease of a handoff that this process runs. */
export function renewHandoff(client: Database, sourceId: string, assignment: string) {
  // Stryker disable next-line BooleanLiteral: equivalent: every path writes, so a deferred begin reaches the same writer reservation before any result
  return transaction(client, true, () =>
    checkHistory(client).map((db) => {
      db.update(internalReviews)
        .set({ leaseAt: new Date().toISOString() })
        .where(and(key(sourceId, assignment), eq(internalReviews.ownerPid, process.pid)))
        .run();
      return undefined;
    }),
  );
}

/**
 * The handoff closed the implementer's pane, so its session ended as planned. A pane event
 * may have recorded the close as an interruption first.
 */
export function finishImplementer(client: Database, launchId: string) {
  // Stryker disable next-line BooleanLiteral: equivalent: every path writes, so a deferred begin reaches the same writer reservation before any result
  return transaction(client, true, () =>
    checkHistory(client).map((db) => {
      db.update(launches)
        .set({
          state: "finished",
          endedAt: new Date().toISOString(),
          failureReason: null,
          failureDetail: null,
        })
        .where(and(eq(launches.id, launchId), inArray(launches.state, ["running", "interrupted"])))
        .run();
      return undefined;
    }),
  );
}

export type RoundFacts = {
  review: InternalReviewRow;
  rounds: InternalReviewRoundRow[];
  launch: LaunchRow;
};

/**
 * Records one round when the caller's rule permits it on the review and the rounds that the
 * write transaction reads. Only the running reviewer launch of an open PR assignment writes.
 */
export function recordInternalReviewRound<E extends { reason: string; detail: string }>(
  client: Database,
  launchId: string,
  decide: (facts: RoundFacts) => Result<Pick<InternalReviewRoundRow, "head" | "findings">, E>,
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) =>
      activeOwner(db, launchId).flatMap(
        ({
          launch,
          source,
          assignment,
        }): Result<InternalReviewRoundRow, PullRequestFailure | E> => {
          const review = db
            .select()
            .from(internalReviews)
            .where(key(source.id, assignment.key))
            .get();
          if (review === undefined)
            return Err({
              reason: "internal_review_not_recorded",
              detail: `Assignment ${assignment.key} has no internal review. Nothing was recorded.`,
            });
          const rounds = db
            .select()
            .from(internalReviewRounds)
            .where(
              and(
                eq(internalReviewRounds.sourceId, source.id),
                eq(internalReviewRounds.assignment, assignment.key),
              ),
            )
            .orderBy(asc(internalReviewRounds.number))
            .all();
          return decide({ review, rounds, launch }).map((round) => {
            const row = {
              sourceId: source.id,
              assignment: assignment.key,
              number: rounds.length + 1,
              launchId,
              ...round,
              recordedAt: new Date().toISOString(),
            };
            db.insert(internalReviewRounds).values(row).run();
            db.update(internalReviews)
              .set({ updatedAt: row.recordedAt })
              .where(key(source.id, assignment.key))
              .run();
            return row;
          });
        },
      ),
    ),
  );
}
