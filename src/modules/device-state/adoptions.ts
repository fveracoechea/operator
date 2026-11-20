import { and, eq, notInArray, or } from "drizzle-orm";
import { Err, Ok } from "unthrown";
import type { Database } from "bun:sqlite";
import type { Db } from "./database.ts";
import { checkHistory, transaction } from "./database.ts";
import { assignments, launches, pullRequests, reviewRequests, sources } from "./schema.ts";
import type { Refusal } from "../../lib/cli-result.ts";

export type AdoptionFailure = Refusal & { reason: "adopt_assignment_owned" | "adopt_review_owned" };

export type AdoptionTarget = {
  repository: string;
  sourceId: string;
  assignment: string;
  branch: string;
  number: number | null;
};

/** Kept assignments own their branch even when the latest worker is interrupted or parked. */
export function adoptionOwner(db: Db, target: AdoptionTarget) {
  const owners = db
    .select({
      sourceId: sources.id,
      assignment: assignments.key,
      branch: launches.branch,
      prBranch: pullRequests.branch,
      number: pullRequests.number,
    })
    .from(assignments)
    .innerJoin(sources, eq(sources.id, assignments.sourceId))
    .leftJoin(
      launches,
      and(eq(launches.sourceId, assignments.sourceId), eq(launches.assignment, assignments.key)),
    )
    .leftJoin(
      pullRequests,
      and(
        eq(pullRequests.sourceId, assignments.sourceId),
        eq(pullRequests.assignment, assignments.key),
      ),
    )
    .where(
      and(
        eq(sources.repository, target.repository),
        eq(sources.state, "open"),
        notInArray(assignments.state, ["merged", "completed", "abandoned"]),
      ),
    )
    .all();
  const owner = owners.find(
    (row) =>
      !(row.sourceId === target.sourceId && row.assignment === target.assignment) &&
      (row.branch === target.branch ||
        row.prBranch === target.branch ||
        (target.number !== null && row.number === target.number)),
  );
  if (owner !== undefined)
    return Err<AdoptionFailure>({
      reason: "adopt_assignment_owned",
      detail: `Assignment ${owner.assignment} in source ${owner.sourceId} owns this PR or branch. Nothing was launched.`,
      next: {
        command: `operator next --source ${owner.sourceId}`,
        why: "Continue the current owner instead of adopting its work.",
      },
      state: { sourceId: owner.sourceId, assignment: owner.assignment },
    });
  const review = db
    .select({ id: reviewRequests.id })
    .from(reviewRequests)
    .where(
      and(
        eq(reviewRequests.repository, target.repository),
        notInArray(reviewRequests.state, ["closed", "skipped"]),
        or(
          eq(reviewRequests.branch, target.branch),
          ...(target.number === null ? [] : [eq(reviewRequests.number, target.number)]),
        ),
      ),
    )
    .get();
  return review === undefined
    ? Ok(undefined)
    : Err<AdoptionFailure>({
        reason: "adopt_review_owned",
        detail: "An open review request owns this PR or branch. Nothing was launched.",
        next: {
          command: "operator review next",
          why: "Finish the existing review request before adopting its PR.",
        },
        state: { request: review.id },
      });
}

export function checkAdoption(client: Database, target: AdoptionTarget) {
  return transaction(client, false, () =>
    checkHistory(client).flatMap((db) => adoptionOwner(db, target)),
  );
}
