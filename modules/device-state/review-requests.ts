import { and, asc, eq, notInArray } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import type { drizzle } from "drizzle-orm/bun-sqlite";
import type { Result } from "unthrown";
import { checkHistory, transaction } from "./database.ts";
import { ownerGone } from "./launches.ts";
import { projects, reviewRequests, reviewRounds } from "./schema.ts";
import type { StateFailure } from "./failures.ts";

export type ReviewRequestRow = typeof reviewRequests.$inferSelect;
export type ReviewRoundRow = typeof reviewRounds.$inferSelect;
export type ReviewSnapshot = {
  project: { repository: string; checkout: string } | null;
  request: ReviewRequestRow | null;
  rounds: ReviewRoundRow[];
  /** The process that started the reviewer or posts the review still runs. */
  ownerActive: boolean;
};
/** One decided change. `hold` gives this process the lease, and `release` ends it. */
export type ReviewChange = {
  insert?: Pick<ReviewRequestRow, "id" | "repository" | "number" | "url" | "origin" | "state">;
  update?: Partial<Omit<ReviewRequestRow, "id">>;
  round?: ReviewRoundRow;
  lease?: "hold" | "release";
};

const ended = ["approved", "closed", "skipped"];

function active(db: ReturnType<typeof drizzle>, repository: string, number: number) {
  return (
    db
      .select()
      .from(reviewRequests)
      .where(
        and(
          eq(reviewRequests.repository, repository),
          eq(reviewRequests.number, number),
          notInArray(reviewRequests.state, ended),
        ),
      )
      .get() ?? null
  );
}

function snapshot(db: ReturnType<typeof drizzle>, request: ReviewRequestRow | null) {
  return {
    request,
    rounds:
      request === null
        ? []
        : db
            .select()
            .from(reviewRounds)
            .where(eq(reviewRounds.requestId, request.id))
            .orderBy(asc(reviewRounds.number))
            .all(),
    ownerActive: request !== null && !ownerGone(request, Date.now()),
  };
}

/**
 * Reads the active request of one PR and applies the change that the caller's rule decides
 * from it, in one write transaction. Two commands on the same PR never act on the same state.
 */
export function changeReviewRequest<E>(
  client: Database,
  target: { repository: string; number: number },
  decide: (current: ReviewSnapshot) => Result<ReviewChange, E>,
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db): Result<ReviewSnapshot, E | StateFailure> => {
      const current = {
        project: project(db, target.repository),
        ...snapshot(db, active(db, target.repository, target.number)),
      };
      return decide(current).map((change) => {
        const now = new Date().toISOString();
        const lease =
          change.lease === "hold"
            ? { ownerPid: process.pid, leaseAt: now }
            : change.lease === "release"
              ? { ownerPid: null, leaseAt: null }
              : {};
        let id = current.request?.id ?? null;
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
        const request =
          id === null
            ? null
            : (db.select().from(reviewRequests).where(eq(reviewRequests.id, id)).get() ?? null);
        return { project: current.project, ...snapshot(db, request) };
      });
    }),
  );
}

function project(db: ReturnType<typeof drizzle>, repository: string) {
  return (
    db
      .select({ repository: projects.repository, checkout: projects.checkout })
      .from(projects)
      .where(eq(projects.repository, repository))
      .get() ?? null
  );
}

/** The active request of one PR, read without a write lock. */
export function readReviewRequest(
  client: Database,
  target: { repository: string; number: number },
) {
  return transaction(client, false, () =>
    checkHistory(client).map((db): ReviewSnapshot => ({
      project: project(db, target.repository),
      ...snapshot(db, active(db, target.repository, target.number)),
    })),
  );
}

/** Every active request on the device, with its rounds and the controlling checkout. */
export function readReviewRequests(client: Database) {
  return transaction(client, false, () =>
    checkHistory(client).map((db) =>
      db
        .select()
        .from(reviewRequests)
        .innerJoin(projects, eq(projects.repository, reviewRequests.repository))
        .where(notInArray(reviewRequests.state, ended))
        .orderBy(asc(reviewRequests.requestedAt))
        .all()
        .map((row) => ({
          project: { repository: row.projects.repository, checkout: row.projects.checkout },
          ...snapshot(db, row.review_requests),
        })),
    ),
  );
}

/** The optional reviewer of a PR assignment. A PR that already has an active request keeps it. */
export function requestAssignmentReview(
  db: ReturnType<typeof drizzle>,
  pr: { repository: string; number: number; url: string; sourceId: string; assignment: string },
) {
  if (active(db, pr.repository, pr.number) !== null) return;
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
  };
}

/** Renew the lease of a start or post that this process runs. */
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
