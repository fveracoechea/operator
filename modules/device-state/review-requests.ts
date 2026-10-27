import { and, asc, desc, eq, inArray, notInArray, or } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import type { drizzle } from "drizzle-orm/bun-sqlite";
import type { Result } from "unthrown";
import { checkHistory, transaction } from "./database.ts";
import { ownerGone } from "./launches.ts";
import { projects, reviewRequests, reviewRounds, reviewThreadOperations } from "./schema.ts";
import type { StateFailure } from "./failures.ts";

export type ReviewRequestRow = typeof reviewRequests.$inferSelect;
export type ReviewRoundRow = typeof reviewRounds.$inferSelect;
export type ThreadOperationRow = typeof reviewThreadOperations.$inferSelect;
export type ReviewSnapshot = {
  project: { repository: string; checkout: string } | null;
  request: ReviewRequestRow | null;
  rounds: ReviewRoundRow[];
  /** The thread operations of the newest round. */
  operations: ThreadOperationRow[];
  /** The process that holds this request's lease still runs. */
  ownerActive: boolean;
  /** The newest closed or skipped request of the PR whose reviewer cleanup did not finish. */
  ended: ReviewRequestRow | null;
};
/** One decided change. `hold` gives this process the lease, and `release` ends it. */
export type ReviewChange = {
  insert?: Pick<ReviewRequestRow, "id" | "repository" | "number" | "url" | "origin" | "state">;
  update?: Partial<Omit<ReviewRequestRow, "id">>;
  round?: ReviewRoundRow;
  operations?: ThreadOperationRow[];
  lease?: "hold" | "release";
};
type Target = { repository: string; number: number; id?: string };
type Db = ReturnType<typeof drizzle>;

const ended = ["closed", "skipped"];
const unfinishedCleanup = ["pending", "failed", "kept"];

/** The open request of one PR, or the request that the target names by its id. */
function current(db: Db, target: Target) {
  return (
    db
      .select()
      .from(reviewRequests)
      .where(
        target.id === undefined
          ? and(
              eq(reviewRequests.repository, target.repository),
              eq(reviewRequests.number, target.number),
              notInArray(reviewRequests.state, ended),
            )
          : eq(reviewRequests.id, target.id),
      )
      .get() ?? null
  );
}

function endedWithCleanup(db: Db, target: Target) {
  return (
    db
      .select()
      .from(reviewRequests)
      .where(
        and(
          eq(reviewRequests.repository, target.repository),
          eq(reviewRequests.number, target.number),
          inArray(reviewRequests.state, ended),
          inArray(reviewRequests.cleanupState, unfinishedCleanup),
        ),
      )
      .orderBy(desc(reviewRequests.endedAt))
      .get() ?? null
  );
}

function snapshot(db: Db, request: ReviewRequestRow | null) {
  const rounds =
    request === null
      ? []
      : db
          .select()
          .from(reviewRounds)
          .where(eq(reviewRounds.requestId, request.id))
          .orderBy(asc(reviewRounds.number))
          .all();
  const last = rounds.at(-1);
  return {
    request,
    rounds,
    operations:
      request === null || last === undefined
        ? []
        : db
            .select()
            .from(reviewThreadOperations)
            .where(
              and(
                eq(reviewThreadOperations.requestId, request.id),
                eq(reviewThreadOperations.round, last.number),
              ),
            )
            .orderBy(asc(reviewThreadOperations.threadId), asc(reviewThreadOperations.kind))
            .all(),
    ownerActive: request !== null && !ownerGone(request, Date.now()),
  };
}

function read(db: Db, target: Target): ReviewSnapshot {
  return {
    project: project(db, target.repository),
    ...snapshot(db, current(db, target)),
    ended: target.id === undefined ? endedWithCleanup(db, target) : null,
  };
}

/**
 * Reads the open request of one PR, or the request with the target's id, and applies the change
 * that the caller's rule decides from it, in one write transaction. Two commands on the same PR
 * never act on the same state.
 */
export function changeReviewRequest<E>(
  client: Database,
  target: Target,
  decide: (current: ReviewSnapshot) => Result<ReviewChange, E>,
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db): Result<ReviewSnapshot, E | StateFailure> => {
      const before = read(db, target);
      return decide(before).map((change) => {
        const now = new Date().toISOString();
        const lease =
          change.lease === "hold"
            ? { ownerPid: process.pid, leaseAt: now }
            : change.lease === "release"
              ? { ownerPid: null, leaseAt: null }
              : {};
        let id = before.request?.id ?? null;
        if (change.insert !== undefined) {
          db.insert(reviewRequests)
            .values({ ...emptyRequest(), ...change.insert, requestedAt: now, ...lease })
            .run();
          id = change.insert.id;
        } else if (id !== null && Object.keys({ ...change.update, ...lease }).length > 0)
          db.update(reviewRequests)
            .set({ ...change.update, ...lease })
            .where(eq(reviewRequests.id, id))
            .run();
        if (change.round !== undefined)
          db.insert(reviewRounds)
            .values(change.round)
            .onConflictDoUpdate({
              target: [reviewRounds.requestId, reviewRounds.number],
              set: change.round,
            })
            .run();
        for (const operation of change.operations ?? [])
          db.insert(reviewThreadOperations)
            .values(operation)
            .onConflictDoUpdate({
              target: [
                reviewThreadOperations.requestId,
                reviewThreadOperations.round,
                reviewThreadOperations.threadId,
                reviewThreadOperations.kind,
              ],
              set: operation,
            })
            .run();
        return {
          ...read(db, id === null ? target : { ...target, id }),
          ended: before.ended,
        };
      });
    }),
  );
}

function project(db: Db, repository: string) {
  return (
    db
      .select({ repository: projects.repository, checkout: projects.checkout })
      .from(projects)
      .where(eq(projects.repository, repository))
      .get() ?? null
  );
}

/** The open request of one PR, read without a write lock. */
export function readReviewRequest(client: Database, target: Target) {
  return transaction(client, false, () => checkHistory(client).map((db) => read(db, target)));
}

/**
 * Every open request on the device, and every ended request whose reviewer cleanup did not
 * finish, each with its rounds and the controlling checkout.
 */
export function readReviewRequests(client: Database) {
  return transaction(client, false, () =>
    checkHistory(client).map((db) =>
      db
        .select()
        .from(reviewRequests)
        .innerJoin(projects, eq(projects.repository, reviewRequests.repository))
        .where(
          or(
            notInArray(reviewRequests.state, ended),
            inArray(reviewRequests.cleanupState, unfinishedCleanup),
          ),
        )
        .orderBy(asc(reviewRequests.requestedAt))
        .all()
        .map((row) => ({
          project: { repository: row.projects.repository, checkout: row.projects.checkout },
          ...snapshot(db, row.review_requests),
          ended: null,
        })),
    ),
  );
}

/** The optional reviewer of a PR assignment. A PR that already has an open request keeps it. */
export function requestAssignmentReview(
  db: Db,
  pr: { repository: string; number: number; url: string; sourceId: string; assignment: string },
) {
  if (current(db, pr) !== null) return;
  db.insert(reviewRequests)
    .values({
      ...emptyRequest(),
      id: crypto.randomUUID(),
      repository: pr.repository,
      number: pr.number,
      url: pr.url,
      origin: "assignment",
      sourceId: pr.sourceId,
      assignment: pr.assignment,
      state: "queued",
      requestedAt: new Date().toISOString(),
    })
    .run();
}

/** A request row with no launch and no end. Callers set its identity and origin. */
function emptyRequest(): Omit<
  ReviewRequestRow,
  "id" | "repository" | "number" | "url" | "origin" | "state" | "requestedAt"
> {
  return {
    sourceId: null,
    assignment: null,
    endedAt: null,
    launchState: null,
    launch: null,
    name: null,
    branch: null,
    head: null,
    herdrSocket: null,
    workspaceId: null,
    tabId: null,
    paneId: null,
    worktreePath: null,
    worktreeWorkspaceId: null,
    failureReason: null,
    failureDetail: null,
    ownerPid: null,
    leaseAt: null,
    trigger: null,
    headMoves: 0,
    activityAt: null,
    staleAt: null,
    resolvedThreads: null,
    sync: null,
    cleanupState: null,
    cleanupDetail: null,
  };
}

/** Renew the lease of a start, post, reviewer move, or cleanup that this process runs. */
export function renewReviewLease(client: Database, id: string) {
  return transaction(client, true, () =>
    checkHistory(client).map((db) => {
      db.update(reviewRequests)
        .set({ leaseAt: new Date().toISOString() })
        .where(and(eq(reviewRequests.id, id), eq(reviewRequests.ownerPid, process.pid)))
        .run();
      return undefined;
    }),
  );
}
