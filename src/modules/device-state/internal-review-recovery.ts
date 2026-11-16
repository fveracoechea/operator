import type { Database } from "bun:sqlite";
import { and, desc, eq, or } from "drizzle-orm";
import { Err, Ok, type Result } from "unthrown";
import { z } from "zod";
import { checkHistory, transaction } from "./database.ts";
import type { StateFailure } from "./failures.ts";
import type { ResultContext } from "../../lib/cli-result.ts";
import {
  assignments,
  sources,
  promotions,
  launches,
  pullRequests,
  internalReviews,
  internalReviewRounds,
  internalReviewRecoveries,
} from "./schema.ts";

type RecoveryInput = {
  repository: string;
  sourceId: string;
  assignment: string;
  launchId: string;
  number: number;
  url: string;
  branch: string;
  worktreePath: string;
  head: string;
  personInstructed: boolean;
};
type RecoveryFailure =
  | StateFailure
  | (ResultContext & {
      reason: "person_instruction_required" | "internal_review_recovery_incompatible";
      detail: string;
    });

function matches<T extends Record<string, unknown>>(
  row: T | undefined,
  expected: Partial<T>,
): row is T {
  return (
    row !== undefined && Object.entries(expected).every(([field, value]) => row[field] === value)
  );
}

function incompatible() {
  return Err<RecoveryFailure>({
    reason: "internal_review_recovery_incompatible",
    detail:
      "The recorded assignment does not match the promoted internal review recovery. Nothing was changed.",
    next: {
      command: "operator next",
      why: "Read the assignment's current state before choosing another action.",
    },
  });
}

function noReviewHistory(
  review: typeof internalReviews.$inferSelect | undefined,
  round: typeof internalReviewRounds.$inferSelect | undefined,
) {
  return review === undefined && round === undefined;
}

function currentImplementer(
  launch: typeof launches.$inferSelect,
  latest: typeof launches.$inferSelect | undefined,
) {
  // Stryker disable next-line OptionalChaining: equivalent: the selected implementer itself guarantees at least one launch for this assignment
  return launch.state === "running" && latest?.id === launch.id;
}

function requiredReview(planText: string, promotionPolicy: boolean | null) {
  if (promotionPolicy !== null) return promotionPolicy;
  let decoded: unknown;
  try {
    decoded = JSON.parse(planText);
  } catch {
    // Invalid JSON leaves no policy for the schema to accept below.
  }
  const plan = z.object({ internalReview: z.boolean().optional() }).safeParse(decoded);
  return plan.success && plan.data.internalReview === true;
}

function auditedRetry(
  audit: typeof internalReviewRecoveries.$inferSelect,
  review: typeof internalReviews.$inferSelect | undefined,
  input: RecoveryInput,
) {
  return (
    matches(audit, {
      repository: input.repository,
      implementerLaunchId: input.launchId,
      number: input.number,
      url: input.url,
      branch: input.branch,
      worktreePath: input.worktreePath,
      head: input.head,
      personInstructed: true,
    }) &&
    matches(review, { implementerLaunchId: input.launchId, state: "reviewing", endedAt: null })
  );
}

export function readInternalReviewRecovery(
  client: Database,
  repository: string,
  sourceId: string,
  assignment: string,
) {
  return transaction(client, false, () =>
    checkHistory(client).map(
      (db) =>
        db
          .select()
          .from(internalReviewRecoveries)
          .where(
            and(
              eq(internalReviewRecoveries.repository, repository),
              eq(internalReviewRecoveries.sourceId, sourceId),
              eq(internalReviewRecoveries.assignment, assignment),
            ),
          )
          .get() ?? null,
    ),
  );
}

/** Rechecks the defect and records its authorization under one SQLite writer reservation. */
export function recoverInternalReview(client: Database, input: RecoveryInput) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db): Result<{ changed: boolean }, RecoveryFailure> => {
      if (!input.personInstructed)
        return Err({
          reason: "person_instruction_required",
          detail:
            "Internal review recovery requires the person's explicit instruction. Nothing was changed.",
          next: {
            command: "operator next",
            why: "Ask the person before recovering an internal review.",
          },
        });
      const source = db.select().from(sources).where(eq(sources.id, input.sourceId)).get();
      const assignment = db
        .select()
        .from(assignments)
        .where(and(eq(assignments.sourceId, input.sourceId), eq(assignments.key, input.assignment)))
        .get();
      const promotion = db
        .select()
        .from(promotions)
        .where(
          and(eq(promotions.sourceId, input.sourceId), eq(promotions.assignment, input.assignment)),
        )
        .get();
      const launch = db.select().from(launches).where(eq(launches.id, input.launchId)).get();
      const pr = db
        .select()
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.sourceId, input.sourceId),
            eq(pullRequests.assignment, input.assignment),
          ),
        )
        .get();
      const review = db
        .select()
        .from(internalReviews)
        .where(
          and(
            eq(internalReviews.sourceId, input.sourceId),
            eq(internalReviews.assignment, input.assignment),
          ),
        )
        .get();
      const audit = db
        .select()
        .from(internalReviewRecoveries)
        .where(
          and(
            eq(internalReviewRecoveries.sourceId, input.sourceId),
            eq(internalReviewRecoveries.assignment, input.assignment),
          ),
        )
        .get();
      const owners = db
        .select()
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.repository, input.repository),
            or(eq(pullRequests.number, input.number), eq(pullRequests.url, input.url)),
          ),
        )
        .all();
      if (
        !matches(source, { repository: input.repository, state: "open" }) ||
        !matches(assignment, { completion: "pr", state: "pr-open" }) ||
        !matches(promotion, {
          handoverLaunchId: input.launchId,
          branch: input.branch,
          worktreePath: input.worktreePath,
        }) ||
        !matches(launch, {
          sourceId: input.sourceId,
          assignment: input.assignment,
          internalReview: null,
          branch: input.branch,
          worktreePath: input.worktreePath,
        }) ||
        !matches(pr, {
          repository: input.repository,
          number: input.number,
          url: input.url,
          branch: input.branch,
          mergedAt: null,
          mergedHead: null,
          mergeCommit: null,
        }) ||
        owners.length !== 1
      )
        return incompatible();
      if (audit !== undefined) {
        if (!auditedRetry(audit, review, input)) return incompatible();
        return Ok({ changed: false });
      }
      const latest = db
        .select()
        .from(launches)
        .where(
          and(eq(launches.sourceId, input.sourceId), eq(launches.assignment, input.assignment)),
        )
        .orderBy(desc(launches.attempt))
        .get();
      const rounds = db
        .select()
        .from(internalReviewRounds)
        .where(
          and(
            eq(internalReviewRounds.sourceId, input.sourceId),
            eq(internalReviewRounds.assignment, input.assignment),
          ),
        )
        .get();
      if (
        !requiredReview(source.plan, promotion.internalReview) ||
        !currentImplementer(launch, latest) ||
        !noReviewHistory(review, rounds)
      )
        return incompatible();
      const now = new Date().toISOString();
      db.insert(internalReviewRecoveries)
        .values({
          sourceId: input.sourceId,
          assignment: input.assignment,
          repository: input.repository,
          implementerLaunchId: input.launchId,
          number: input.number,
          url: input.url,
          branch: input.branch,
          worktreePath: input.worktreePath,
          head: input.head,
          personInstructed: true,
          authorizedAt: now,
        })
        .run();
      db.insert(internalReviews)
        .values({
          sourceId: input.sourceId,
          assignment: input.assignment,
          implementerLaunchId: input.launchId,
          state: "reviewing",
          handoffState: "pending",
          startedAt: now,
          updatedAt: now,
          ownerPid: process.pid,
          leaseAt: now,
        })
        .run();
      return Ok({ changed: true });
    }),
  );
}
