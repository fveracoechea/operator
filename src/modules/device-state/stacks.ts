import { and, eq, notInArray } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import { Err, Ok, type Result } from "unthrown";
import { checkHistory, transaction, type Db } from "./database.ts";
import { activeOwner } from "./pull-requests.ts";
import {
  stackOperations,
  stackBases,
  sources,
  internalReviews,
  internalReviewRounds,
  pullRequests,
  launches,
} from "./schema.ts";
import { ownerGone } from "./leases.ts";
import type { Refusal } from "../../lib/cli-result.ts";

export type StackRow = typeof stackOperations.$inferSelect;

function stackClaim(
  db: Db,
  row: StackRow | undefined,
  launch: typeof launches.$inferSelect,
  revision: number | null,
): Result<void, Refusal> {
  if (row === undefined) {
    if (revision !== null) return refused("The stack operation no longer exists.");
    const unfinished = db
      .select()
      .from(stackOperations)
      .where(
        and(
          eq(stackOperations.sourceId, launch.sourceId),
          eq(stackOperations.assignment, launch.assignment),
          notInArray(stackOperations.state, ["complete", "cancelled"]),
        ),
      )
      .get();
    return unfinished === undefined
      ? Ok(undefined)
      : refused(`Operation ${unfinished.id} must finish or be cancelled before another plan.`);
  }
  if (
    row.sourceId !== launch.sourceId ||
    row.assignment !== launch.assignment ||
    row.revision !== revision
  )
    return refused("The operation owner or revision changed. No stack effect was authorized.");
  if (row.launchId !== launch.id) {
    const previous = db.select().from(launches).where(eq(launches.id, row.launchId)).get();
    if (previous?.branch !== launch.branch || previous.worktreePath !== launch.worktreePath)
      return refused(
        "A replacement can recover a stack only in the same recorded worktree and branch.",
      );
  }
  // A long external call cannot lose its claim merely because its lease timestamp aged.
  return row.ownerPid !== process.pid &&
    !ownerGone({ ...row, leaseAt: new Date().toISOString() }, Date.now())
    ? refused("Another process holds this stack operation. No competing effect was authorized.")
    : Ok(undefined);
}

/** Stack bases are separate records; the registered source plan remains immutable. */
export function recordStackBase(client: Database, launchId: string, branch: string, data: string) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) =>
      activeOwner(db, launchId, true, true).flatMap(({ source, assignment, launch }) => {
        if (launch.branch !== branch)
          return refused("The stack base does not belong to this launch's branch.");
        const row = { sourceId: source.id, assignment: assignment.key, launchId, branch, data };
        db.insert(stackBases)
          .values(row)
          .onConflictDoUpdate({ target: [stackBases.sourceId, stackBases.assignment], set: row })
          .run();
        return Ok(row);
      }),
    ),
  );
}

export function readStackBases(client: Database, repository: string, sourceId: string) {
  return transaction(client, false, () =>
    checkHistory(client).flatMap((db) => {
      const source = db
        .select()
        .from(sources)
        .where(and(eq(sources.id, sourceId), eq(sources.repository, repository)))
        .get();
      return source === undefined
        ? refused("The stack source does not belong to this repository.")
        : Ok(db.select().from(stackBases).where(eq(stackBases.sourceId, sourceId)).all());
    }),
  );
}

/** Final operation progress, dependency provenance, and relay obligations become visible together. */
export function finishStack(
  client: Database,
  launchId: string,
  id: string,
  revision: number,
  effect: { data: string; base: string; relay: string; state?: "complete" | "cancelled" },
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) =>
      activeOwner(db, launchId, true).flatMap(({ source, assignment, launch }) => {
        const row = db.select().from(stackOperations).where(eq(stackOperations.id, id)).get();
        if (
          row?.sourceId !== source.id ||
          row.assignment !== assignment.key ||
          row.launchId !== launchId ||
          row.revision !== revision ||
          row.ownerPid !== process.pid ||
          launch.branch === null
        )
          return refused("The pinned operation lost its claim before finalization.");
        const next = {
          ...row,
          data: effect.data,
          state: effect.state ?? "complete",
          revision: revision + 1,
          ownerPid: null,
          leaseAt: null,
        };
        db.update(stackOperations).set(next).where(eq(stackOperations.id, id)).run();
        const base = {
          sourceId: source.id,
          assignment: assignment.key,
          launchId,
          branch: launch.branch,
          data: effect.base,
        };
        db.insert(stackBases)
          .values(base)
          .onConflictDoUpdate({ target: [stackBases.sourceId, stackBases.assignment], set: base })
          .run();
        db.update(pullRequests)
          .set({
            relay: effect.relay,
            progress: JSON.stringify({ seen: [], failures: [], eligibleHead: null }),
          })
          .where(
            and(eq(pullRequests.sourceId, source.id), eq(pullRequests.assignment, assignment.key)),
          )
          .run();
        return Ok(next);
      }),
    ),
  );
}

export function stackIdle(client: Database, launchId: string) {
  return transaction(client, false, () =>
    checkHistory(client).flatMap((db) => activeOwner(db, launchId).as(undefined)),
  );
}

function refused(detail: string) {
  return Err<Refusal>({
    reason: "stack_stale",
    detail,
    next: {
      command: "operator pr stack plan",
      why: "Inspect the current owned stack before planning another change.",
    },
  });
}

/** A stack record can only be read or changed by its current active PR owner. */
export function readStack(client: Database, launchId: string, id: string) {
  return transaction(client, false, () =>
    checkHistory(client).flatMap((db) =>
      activeOwner(db, launchId, true).flatMap(({ source, assignment }) => {
        const row = db
          .select()
          .from(stackOperations)
          .where(
            and(
              eq(stackOperations.id, id),
              eq(stackOperations.sourceId, source.id),
              eq(stackOperations.assignment, assignment.key),
            ),
          )
          .get();
        return row === undefined
          ? refused("No operation with that identity belongs to this assignment.")
          : Ok(row);
      }),
    ),
  );
}

/** Revision checks and a live-process claim serialize effects without holding a database transaction. */
export function changeStack(
  client: Database,
  launchId: string,
  id: string,
  revision: number | null,
  decide: (row: StackRow | null) => Result<Pick<StackRow, "state" | "data" | "ownerPid">, Refusal>,
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) =>
      activeOwner(db, launchId, true).flatMap(
        ({ source, assignment, launch }): Result<StackRow, Refusal> => {
          const handoff = db
            .select()
            .from(internalReviews)
            .where(
              and(
                eq(internalReviews.sourceId, source.id),
                eq(internalReviews.assignment, assignment.key),
              ),
            )
            .get();
          if (
            handoff?.handoffState === "pending" &&
            handoff.ownerPid !== process.pid &&
            !ownerGone(handoff, Date.now())
          )
            return refused("A live internal-review handoff already owns this assignment.");
          const row = db.select().from(stackOperations).where(eq(stackOperations.id, id)).get();
          const claim = stackClaim(db, row, launch, revision);
          if (claim.tag !== "Ok")
            return claim.flatMap(() => refused("The operation claim failed."));
          return decide(row ?? null).map((change) => {
            if (row !== undefined && row.launchId !== launchId && row.reviewHistory !== null)
              db.update(internalReviews)
                .set({
                  implementerLaunchId: launchId,
                  handoffState: "pending",
                  ownerPid: null,
                  leaseAt: null,
                })
                .where(
                  and(
                    eq(internalReviews.sourceId, source.id),
                    eq(internalReviews.assignment, assignment.key),
                  ),
                )
                .run();
            const next: StackRow = {
              id,
              sourceId: source.id,
              assignment: assignment.key,
              launchId,
              revision: (revision ?? 0) + 1,
              ...change,
              reviewHistory: row?.reviewHistory ?? null,
              leaseAt: new Date().toISOString(),
            };
            if (row === undefined) db.insert(stackOperations).values(next).run();
            else db.update(stackOperations).set(next).where(eq(stackOperations.id, id)).run();
            return next;
          });
        },
      ),
    ),
  );
}

/** Archive the old review before any changed-head effect, then use the ordinary fresh-reader handoff. */
export function restartStackReview(
  client: Database,
  launchId: string,
  id: string,
  revision: number,
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) =>
      activeOwner(db, launchId, true).flatMap(
        ({ source, assignment }): Result<StackRow, Refusal> => {
          const operation = db
            .select()
            .from(stackOperations)
            .where(eq(stackOperations.id, id))
            .get();
          if (
            operation?.sourceId !== source.id ||
            operation.assignment !== assignment.key ||
            operation.launchId !== launchId ||
            operation.revision !== revision ||
            operation.ownerPid !== process.pid
          )
            return refused("Only the exact claimed stack operation can invalidate its review.");
          if (operation.reviewHistory !== null) return Ok(operation);
          const key = and(
            eq(internalReviews.sourceId, source.id),
            eq(internalReviews.assignment, assignment.key),
          );
          const roundsKey = and(
            eq(internalReviewRounds.sourceId, source.id),
            eq(internalReviewRounds.assignment, assignment.key),
          );
          const review = db.select().from(internalReviews).where(key).get() ?? null;
          const rounds = db.select().from(internalReviewRounds).where(roundsKey).all();
          const now = new Date().toISOString();
          const archived = {
            ...operation,
            revision: revision + 1,
            reviewHistory: JSON.stringify({ review, rounds }),
            leaseAt: now,
          };
          db.update(stackOperations).set(archived).where(eq(stackOperations.id, id)).run();
          db.delete(internalReviewRounds).where(roundsKey).run();
          const fresh = {
            sourceId: source.id,
            assignment: assignment.key,
            state: "reviewing",
            implementerLaunchId: launchId,
            handoffState: "pending",
            handoffDetail: null,
            ownerPid: null,
            leaseAt: null,
            readyHead: null,
            commentId: null,
            commentUrl: null,
            endedAt: null,
            startedAt: now,
            updatedAt: now,
          };
          if (review === null) db.insert(internalReviews).values(fresh).run();
          else db.update(internalReviews).set(fresh).where(key).run();
          db.update(pullRequests)
            .set({ progress: JSON.stringify({ seen: [], failures: [], eligibleHead: null }) })
            .where(
              and(
                eq(pullRequests.sourceId, source.id),
                eq(pullRequests.assignment, assignment.key),
              ),
            )
            .run();
          return Ok(archived);
        },
      ),
    ),
  );
}
