import { and, desc, eq, gt, isNotNull } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import { Err, Ok, fromThrowable, type Result } from "unthrown";
import { z } from "zod";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { reviewHandoffTarget } from "./handoff-target.ts";
import { recordPrReady, storedPrReadinessSchema, type PrReadiness } from "./pr-readiness.ts";
import { checkHistory, transaction, type Db } from "./database.ts";
import { ownerGone } from "./leases.ts";
import {
  assignments,
  cleanups,
  internalReviews,
  kindHandoffs,
  launches,
  projects,
  pullRequests,
  sources,
} from "./schema.ts";
import { stateFailure, type StateFailure } from "./failures.ts";
import { requestAssignmentReview } from "./review-requests.ts";
import { abandonConversations } from "./sources.ts";
import type { RefusalContext } from "../../lib/cli-result.ts";

export type PullRequestRow = typeof pullRequests.$inferSelect;
export type PullRequestFailure =
  | StateFailure
  | (RefusalContext & {
      reason:
        | "pr_owner_inactive"
        | "pr_already_associated"
        | "pr_owned_elsewhere"
        | "pr_not_associated"
        | "pr_branch_mismatch"
        | "internal_review_not_recorded"
        | "handoff_running";
      detail: string;
    });

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
          progress: pullRequests.progress,
          readiness: pullRequests.readiness,
          internalReview: launches.internalReview,
          kind: launches.kind,
          reviewState: internalReviews.state,
          implementerLaunchId: internalReviews.implementerLaunchId,
          outgoingLaunchId: kindHandoffs.outgoingLaunchId,
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
        .leftJoin(
          internalReviews,
          and(
            eq(internalReviews.sourceId, launches.sourceId),
            eq(internalReviews.assignment, launches.assignment),
          ),
        )
        .leftJoin(
          kindHandoffs,
          and(
            eq(kindHandoffs.sourceId, launches.sourceId),
            eq(kindHandoffs.assignment, launches.assignment),
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
  ).flatMap((rows) =>
    fromThrowable(
      () =>
        rows.map((row) => ({ ...row, readiness: storedPrReadinessSchema.parse(row.readiness) })),
      (cause, defect) =>
        cause instanceof SyntaxError || cause instanceof z.ZodError
          ? stateFailure(
              "state_corrupt",
              "The recorded PR readiness is invalid. Nothing was changed.",
              { readinessValid: false },
            )
          : defect(cause),
    )(),
  );
}

/**
 * Every PR write checks again that this launch is the running latest start of an open PR
 * assignment. A replaced or interrupted owner cannot change the assignment or its progress.
 */
export function activeOwner(db: Db, launchId: string) {
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
      next: { command: "operator next", why: "Read the current PR owner before continuing." },
      detail:
        "This worktree no longer belongs to the running owner of an open PR assignment. Nothing was changed.",
    });
  return Ok(owner);
}

/**
 * Records a new internal review in the association's own write. Its handoff is pending and held
 * by the associating process until the handoff process that it starts takes it over.
 */
function insertInternalReview(
  db: Db,
  review: { sourceId: string; assignment: string; implementerLaunchId: string },
  nextKind: string,
) {
  const now = new Date().toISOString();
  db.insert(internalReviews)
    .values({
      ...review,
      state: "reviewing",
      // Historical columns stay for migration history; kind_handoffs owns new transitions.
      handoffState: "done",
      handoffDetail: null,
      startedAt: now,
      updatedAt: now,
      ownerPid: null,
      leaseAt: null,
      readyHead: null,
      commentId: null,
      commentUrl: null,
      endedAt: null,
    })
    .run();
  db.insert(kindHandoffs)
    .values({
      sourceId: review.sourceId,
      assignment: review.assignment,
      outgoingLaunchId: review.implementerLaunchId,
      nextKind,
      handoffState: "pending",
      handoffDetail: null,
      startedAt: now,
      updatedAt: now,
      ownerPid: process.pid,
      leaseAt: now,
    })
    .run();
}

function current(db: Db, sourceId: string, assignment: string) {
  return db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.sourceId, sourceId), eq(pullRequests.assignment, assignment)))
    .get();
}

type Association = Pick<PullRequestRow, "number" | "url" | "branch" | "relay"> & {
  readiness?: PrReadiness;
};

/** Only this review-off owner can advance its draft association, never an old review or receipt. */
function repeatAssociation(
  db: Db,
  owner: Extract<ReturnType<typeof activeOwner>, { tag: "Ok" }>["value"],
  existing: PullRequestRow,
  pr: Association,
  review: boolean,
  internalReview: boolean,
): Result<{ row: PullRequestRow; changed: boolean }, PullRequestFailure> {
  const { source, assignment, launch } = owner;
  if (existing.number !== pr.number)
    return Err({
      reason: "pr_already_associated",
      next: {
        command: "operator pr wait",
        why: "Continue the assignment's existing PR rather than associating another.",
      },
      state: { pullRequest: existing.number },
      detail: `Assignment ${assignment.key} already owns PR #${existing.number}. Nothing was changed.`,
    });
  const reviewed = db
    .select()
    .from(internalReviews)
    .where(
      and(eq(internalReviews.sourceId, source.id), eq(internalReviews.assignment, assignment.key)),
    )
    .get();
  if (
    existing.readiness !== null ||
    pr.readiness === undefined ||
    internalReview ||
    launch.internalReview !== false ||
    existing.branch !== launch.branch ||
    pr.branch !== existing.branch ||
    reviewed !== undefined
  )
    return Ok({ row: existing, changed: false });
  return recordPrReady(
    db,
    { sourceId: source.id, assignment: assignment.key, launchId: launch.id },
    pr.readiness,
    "pr-feedback",
  ).map(() => {
    if (review)
      requestAssignmentReview(db, {
        repository: source.repository,
        number: existing.number,
        url: existing.url,
        sourceId: source.id,
        assignment: assignment.key,
      });
    return { row: { ...existing, readiness: JSON.stringify(pr.readiness) }, changed: true };
  });
}

/**
 * One PR moves its assignment from running to PR open. Its review-off owner can later record ready.
 * With internal review on, the same write records the review and its pending handoff.
 */
export function associatePullRequest(
  client: Database,
  launchId: string,
  pr: Association,
  review = false,
  internalReview = false,
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) =>
      activeOwner(db, launchId).flatMap(
        (owner): Result<{ row: PullRequestRow; changed: boolean }, PullRequestFailure> => {
          const { source, assignment, launch } = owner;
          const existing = current(db, source.id, assignment.key);
          if (existing !== undefined)
            return repeatAssociation(db, owner, existing, pr, review, internalReview);
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
              next: {
                decider: "super-agent",
                question: "Which assignment should retain ownership of this PR?",
              },
              state: { pullRequest: pr.number, ownedElsewhere: true },
              detail: `PR #${pr.number} belongs to another open PR assignment. Nothing was changed.`,
            });
          const row: PullRequestRow = {
            sourceId: source.id,
            assignment: assignment.key,
            repository: source.repository,
            number: pr.number,
            url: pr.url,
            branch: pr.branch,
            relay: pr.relay,
            readiness: null,
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
          if (internalReview)
            insertInternalReview(
              db,
              {
                sourceId: source.id,
                assignment: assignment.key,
                implementerLaunchId: launchId,
              },
              reviewHandoffTarget(
                launch.kind === null
                  ? null
                  : WorkerKinds.snapshotSchema().parse(JSON.parse(launch.kind)),
              ),
            );
          if (pr.readiness !== undefined && !internalReview) {
            const recorded = recordPrReady(
              db,
              { sourceId: source.id, assignment: assignment.key, launchId },
              pr.readiness,
              "pr-feedback",
            );
            if (recorded.tag === "Err") return Err(recorded.error);
            row.readiness = JSON.stringify(pr.readiness);
          }
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
              next: {
                command: "operator pr associate",
                why: "Associate the assignment's open PR before waiting.",
              },
              state: { pullRequest: null },
              detail: "Run operator pr associate after you open the PR. Nothing was changed.",
            });
          // Only the PR's own branch reaches the PR, so another branch cannot answer its loop.
          if (launch.branch !== row.branch)
            return Err({
              reason: "pr_branch_mismatch",
              next: {
                decider: "super-agent",
                question:
                  "How should the recorded launch and PR branches be reconciled without losing work?",
              },
              state: { launchBranch: launch.branch, prBranch: row.branch },
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
            next: {
              decider: "super-agent",
              question: "Why does the observed merge not match the assignment's recorded open PR?",
            },
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
        abandonConversations(db, source.id, [assignment.key]);
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
