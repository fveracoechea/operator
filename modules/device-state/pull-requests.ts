import { and, desc, eq, gt, isNotNull } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import { Err, Ok, type Result } from "unthrown";
import { z } from "zod";
import { checkHistory, transaction, type Db } from "./database.ts";
import { ownerGone } from "./leases.ts";
import { assignments, cleanups, launches, projects, pullRequests, sources } from "./schema.ts";
import type { StateFailure } from "./failures.ts";
import { requestAssignmentReview } from "./review-requests.ts";

export type PullRequestRow = typeof pullRequests.$inferSelect;
export type PullRequestFailure =
  | StateFailure
  | {
      reason:
        | "pr_owner_inactive"
        | "pr_already_associated"
        | "pr_owned_elsewhere"
        | "pr_not_associated"
        | "pr_branch_mismatch";
      detail: string;
    };

/** The latest launch of each assignment that recorded a worktree, with its owning records. */
export function worktreeOwners(client: Database) {
  return transaction(client, false, () =>
    checkHistory(client).map((db) =>
      db
        .select({
          launchId: launches.id,
          attempt: launches.attempt,
          launchState: launches.state,
          worktreePath: launches.worktreePath,
          branch: launches.branch,
          sourceId: sources.id,
          sourceState: sources.state,
          repository: sources.repository,
          checkout: projects.checkout,
          assignment: assignments.key,
          completion: assignments.completion,
          assignmentState: assignments.state,
          pullRequest: pullRequests.number,
          relay: pullRequests.relay,
        })
        .from(launches)
        .innerJoin(sources, eq(sources.id, launches.sourceId))
        .innerJoin(projects, eq(projects.repository, sources.repository))
        .innerJoin(
          assignments,
          and(
            eq(assignments.sourceId, launches.sourceId),
            eq(assignments.key, launches.assignment),
          ),
        )
        .leftJoin(
          pullRequests,
          and(
            eq(pullRequests.sourceId, launches.sourceId),
            eq(pullRequests.assignment, launches.assignment),
          ),
        )
        .where(isNotNull(launches.worktreePath))
        .orderBy(desc(launches.attempt))
        .all()
        .filter(
          (row, index, rows) =>
            rows.findIndex(
              (other) => other.sourceId === row.sourceId && other.assignment === row.assignment,
            ) === index,
        ),
    ),
  );
}

/**
 * Every PR write checks again that this launch is the running latest start of an open PR
 * assignment. A replaced or interrupted owner cannot change the assignment or its progress.
 */
function activeOwner(db: Db, launchId: string) {
  const owner = db
    .select({ launch: launches, source: sources, assignment: assignments })
    .from(launches)
    .innerJoin(sources, eq(sources.id, launches.sourceId))
    .innerJoin(
      assignments,
      and(eq(assignments.sourceId, launches.sourceId), eq(assignments.key, launches.assignment)),
    )
    .where(eq(launches.id, launchId))
    .get();
  const newer =
    owner === undefined
      ? undefined
      : db
          .select({ id: launches.id })
          .from(launches)
          .where(
            and(
              eq(launches.sourceId, owner.launch.sourceId),
              eq(launches.assignment, owner.launch.assignment),
              gt(launches.attempt, owner.launch.attempt),
            ),
          )
          .get();
  if (
    owner?.launch.state !== "running" ||
    newer !== undefined ||
    owner.source.state !== "open" ||
    owner.assignment.completion !== "pr" ||
    !["running", "pr-open"].includes(owner.assignment.state)
  )
    return Err<PullRequestFailure>({
      reason: "pr_owner_inactive",
      detail:
        "This worktree no longer belongs to the running owner of an open PR assignment. Nothing was changed.",
    });
  return Ok(owner);
}

function current(db: Db, sourceId: string, assignment: string) {
  return db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.sourceId, sourceId), eq(pullRequests.assignment, assignment)))
    .get();
}

/** One PR moves its assignment from running to PR open. A repeated association changes nothing. */
export function associatePullRequest(
  client: Database,
  launchId: string,
  pr: Pick<PullRequestRow, "number" | "url" | "branch" | "relay">,
  review = false,
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) =>
      activeOwner(db, launchId).flatMap(
        ({
          source,
          assignment,
        }): Result<{ row: PullRequestRow; changed: boolean }, PullRequestFailure> => {
          const existing = current(db, source.id, assignment.key);
          if (existing !== undefined)
            return existing.number === pr.number
              ? Ok({ row: existing, changed: false })
              : Err({
                  reason: "pr_already_associated",
                  detail: `Assignment ${assignment.key} already owns PR #${existing.number}. Nothing was changed.`,
                });
          const owned = db
            .select({ assignment: pullRequests.assignment })
            .from(pullRequests)
            .innerJoin(
              assignments,
              and(
                eq(assignments.sourceId, pullRequests.sourceId),
                eq(assignments.key, pullRequests.assignment),
              ),
            )
            .where(
              and(
                eq(pullRequests.repository, source.repository),
                eq(pullRequests.number, pr.number),
                eq(assignments.state, "pr-open"),
              ),
            )
            .get();
          if (owned !== undefined)
            return Err({
              reason: "pr_owned_elsewhere",
              detail: `PR #${pr.number} belongs to another open PR assignment. Nothing was changed.`,
            });
          const row: PullRequestRow = {
            sourceId: source.id,
            assignment: assignment.key,
            repository: source.repository,
            ...pr,
            associatedAt: new Date().toISOString(),
            progress: JSON.stringify({ seen: [], failures: [], eligibleHead: null }),
            waitState: "idle",
            waitAt: null,
            waitOwnerPid: null,
            waitLeaseAt: null,
            mergedHead: null,
            mergeCommit: null,
            mergedAt: null,
          };
          db.insert(pullRequests).values(row).run();
          db.update(assignments)
            .set({ state: "pr-open" })
            .where(and(eq(assignments.sourceId, source.id), eq(assignments.key, assignment.key)))
            .run();
          if (review)
            requestAssignmentReview(db, {
              repository: source.repository,
              number: pr.number,
              url: pr.url,
              sourceId: source.id,
              assignment: assignment.key,
            });
          return Ok({ row, changed: true });
        },
      ),
    ),
  );
}

// Device state reads only the claim of a relay. Its progress belongs to the PR feedback loop.
const relayLease = z.object({
  ownerPid: z.number().int().nullable().default(null),
  leaseAt: z.string().nullable().default(null),
});

/** Another live process runs the relay of this PR, so this process must not touch the branch. */
function relayHeld(row: PullRequestRow) {
  if (row.relay === null) return false;
  const { ownerPid, leaseAt } = relayLease.parse(JSON.parse(row.relay));
  // A claim with no owner is gone, so it holds nothing.
  return ownerPid !== process.pid && !ownerGone({ ownerPid, leaseAt }, Date.now());
}

/**
 * A wait records its start, which clears an earlier timeout, and then each reported result.
 * The decision reads the progress inside the write transaction, so simultaneous waits never
 * report the same observation twice. A relay records its claim and its progress the same way.
 */
export function recordPullRequestWait(
  client: Database,
  launchId: string,
  decide: (
    row: PullRequestRow & { relayHeld: boolean },
  ) =>
    | (Pick<PullRequestRow, "progress" | "waitState"> & Partial<Pick<PullRequestRow, "relay">>)
    | null,
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) =>
      activeOwner(db, launchId).flatMap(
        ({ launch, source, assignment }): Result<PullRequestRow | null, PullRequestFailure> => {
          const row = current(db, source.id, assignment.key);
          if (row === undefined || assignment.state !== "pr-open")
            return Err({
              reason: "pr_not_associated",
              detail: "Run operator pr associate after you open the PR. Nothing was changed.",
            });
          // Only the PR's own branch reaches the PR, so another branch cannot answer its loop.
          if (launch.branch !== row.branch)
            return Err({
              reason: "pr_branch_mismatch",
              detail: `This launch is on ${launch.branch ?? "no branch"}, but PR #${row.number} is on ${row.branch}. Nothing was changed.`,
            });
          const change = decide({ ...row, relayHeld: relayHeld(row) });
          if (change === null) return Ok(null);
          const now = new Date().toISOString();
          // Only a running wait holds a lease. Its result releases it.
          const waiting = change.waitState === "waiting";
          const next = {
            ...row,
            ...change,
            waitAt: now,
            waitOwnerPid: waiting ? process.pid : null,
            waitLeaseAt: waiting ? now : null,
          };
          db.update(pullRequests)
            .set(next)
            .where(
              and(
                eq(pullRequests.sourceId, source.id),
                eq(pullRequests.assignment, assignment.key),
              ),
            )
            .run();
          return Ok(next);
        },
      ),
    ),
  );
}

/** Renew the lease of a wait that this process runs. */
export function renewPullRequestWait(client: Database, sourceId: string, assignment: string) {
  // Stryker disable next-line BooleanLiteral: equivalent: every path writes, so a deferred begin reaches the same writer reservation before any result
  return transaction(client, true, () =>
    checkHistory(client).map((db) => {
      db.update(pullRequests)
        .set({ waitLeaseAt: new Date().toISOString() })
        .where(
          and(
            eq(pullRequests.sourceId, sourceId),
            eq(pullRequests.assignment, assignment),
            eq(pullRequests.waitState, "waiting"),
            eq(pullRequests.waitOwnerPid, process.pid),
          ),
        )
        .run();
      return undefined;
    }),
  );
}

type AssignmentStates = Pick<typeof assignments.$inferSelect, "key" | "completion" | "state">[];

/**
 * A verified merge moves the assignment from PR open to merged and records the first cleanup
 * step in the same transaction, so a merge can never end without its cleanup obligation.
 * A repeated record of the same merge changes nothing.
 */
export function recordPullRequestMerge(
  client: Database,
  launchId: string,
  merge: { number: number; head: string; mergeCommit: string },
  sourceState: (rows: AssignmentStates) => string,
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db): Result<{ changed: boolean }, PullRequestFailure> => {
      const launch = db.select().from(launches).where(eq(launches.id, launchId)).get();
      const recorded =
        launch === undefined ? undefined : current(db, launch.sourceId, launch.assignment);
      if (
        recorded !== undefined &&
        recorded.mergedHead !== null &&
        recorded.number === merge.number
      )
        return Ok({ changed: false });
      return activeOwner(db, launchId).flatMap(({ source, assignment }) => {
        const row = current(db, source.id, assignment.key);
        if (row === undefined || assignment.state !== "pr-open" || row.number !== merge.number)
          return Err<PullRequestFailure>({
            reason: "pr_not_associated",
            detail: `PR #${merge.number} is not the open PR of assignment ${assignment.key}. Nothing was changed.`,
          });
        const now = new Date().toISOString();
        const key = and(
          eq(pullRequests.sourceId, source.id),
          eq(pullRequests.assignment, assignment.key),
        );
        db.update(pullRequests)
          .set({ mergedHead: merge.head, mergeCommit: merge.mergeCommit, mergedAt: now })
          .where(key)
          .run();
        db.update(assignments)
          .set({ state: "merged" })
          .where(and(eq(assignments.sourceId, source.id), eq(assignments.key, assignment.key)))
          .run();
        db.insert(cleanups)
          .values({
            sourceId: source.id,
            assignment: assignment.key,
            launchId,
            step: "remote_branch",
            state: "pending",
            reason: null,
            detail: null,
            updatedAt: now,
            ownerPid: null,
            leaseAt: null,
          })
          .run();
        const state = sourceState(
          db
            .select({
              key: assignments.key,
              completion: assignments.completion,
              state: assignments.state,
            })
            .from(assignments)
            .where(eq(assignments.sourceId, source.id))
            .all(),
        );
        if (state !== source.state)
          db.update(sources).set({ state, endedAt: now }).where(eq(sources.id, source.id)).run();
        return Ok({ changed: true });
      });
    }),
  );
}

/** Renew the claim of a relay that this process runs, so no other wait takes over its Git steps. */
export function renewPullRequestRelay(client: Database, sourceId: string, assignment: string) {
  // Stryker disable next-line BooleanLiteral: equivalent: every path writes, so a deferred begin reaches the same writer reservation before any result
  return transaction(client, true, () =>
    checkHistory(client).map(() => {
      client
        .query(
          "UPDATE pull_requests SET relay = json_set(relay, '$.leaseAt', ?) WHERE source_id = ? AND assignment = ? AND json_extract(relay, '$.ownerPid') = ?",
        )
        .run(new Date().toISOString(), sourceId, assignment, process.pid);
      return undefined;
    }),
  );
}
