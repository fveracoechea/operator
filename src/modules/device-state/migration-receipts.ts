import { and, eq } from "drizzle-orm";
import type { Db } from "./database.ts";
import { assignments, internalReviews, kindHandoffs, launches } from "./schema.ts";
import { ownerGone } from "./leases.ts";
import { decideParking, historicalOwnerIsIdle, type ParkingFacts } from "./pr-parking-machine.ts";
import type { PrParking } from "./pr-parking.ts";

/** A migration marker never substitutes for the absence of a live owner or held effect. */
function historicalOwnerFacts(db: Db, launch: typeof launches.$inferSelect) {
  const handoff = db
    .select()
    .from(kindHandoffs)
    .where(
      and(
        eq(kindHandoffs.sourceId, launch.sourceId),
        eq(kindHandoffs.assignment, launch.assignment),
      ),
    )
    .get();
  const review = db
    .select()
    .from(internalReviews)
    .where(
      and(
        eq(internalReviews.sourceId, launch.sourceId),
        eq(internalReviews.assignment, launch.assignment),
      ),
    )
    .get();
  const now = Date.now();
  return {
    historicalLaunchState: launch.state,
    historicalOwnerIdle:
      ownerGone(launch, now) &&
      (handoff === undefined || ownerGone(handoff, now)) &&
      (review === undefined || ownerGone(review, now)),
  };
}

export function historicalLaunchIdle(db: Db, launch: typeof launches.$inferSelect) {
  return historicalOwnerIsIdle(historicalOwnerFacts(db, launch));
}

/** Gather recorded identity and owner observations. The parking machine owns eligibility. */
export function migrationParkingFacts(
  db: Db,
  launch: typeof launches.$inferSelect | undefined,
  receipt: (Pick<PrParking, "state" | "launchId" | "events"> & { origin?: string }) | null,
): ParkingFacts {
  const assignment =
    launch === undefined
      ? undefined
      : db
          .select()
          .from(assignments)
          .where(
            and(eq(assignments.sourceId, launch.sourceId), eq(assignments.key, launch.assignment)),
          )
          .get();
  return {
    event: "reserve",
    state: receipt?.state ?? null,
    ready: false,
    feedbackOwner: assignment?.kind === "pr-feedback",
    repositoryMatches: true,
    sourceOpen: true,
    assignmentOpen: assignment?.state === "pr-open",
    launchMatches: launch !== undefined && receipt?.launchId === launch.id,
    launchFinished: launch?.state === "finished",
    leaseOwned: false,
    outgoingMatches: false,
    hasEvents: (receipt?.events.length ?? 0) > 0,
    migrationOrigin: receipt?.origin === "migration-0026",
    ...(launch === undefined
      ? { historicalOwnerIdle: false, historicalLaunchState: null }
      : historicalOwnerFacts(db, launch)),
  };
}

/** The first resume reserves a new worker without rewriting the historical launch. */
export function migrationResume(
  db: Db,
  launch: typeof launches.$inferSelect | undefined,
  receipt: (Pick<PrParking, "state" | "launchId" | "events"> & { origin?: string }) | null,
) {
  return decideParking(migrationParkingFacts(db, launch, receipt)).result === "transition";
}
