import { and, eq, isNull } from "drizzle-orm";
import { Err, Ok, type Result } from "unthrown";
import type { Refusal } from "../../lib/cli-result.ts";
import type { Db } from "./database.ts";
import { z } from "zod";
import { commitDeliveries, deliveries, pullRequests, stackOperations } from "./schema.ts";
import { ownerGone } from "./leases.ts";

export function deliveryRefusal<R extends string>(reason: R, detail: string) {
  return Err<Refusal & { reason: R }>({
    reason,
    detail,
    next: {
      decider: "super-agent",
      question:
        "How should the pending PR effect be reconciled without losing work or repeating it?",
    },
  });
}

/** Shared with stack admission. Process death does not cancel an accepted remote effect. */
export function deliveryIdle(
  db: Db,
  sourceId: string,
  assignment?: string,
  allowQueuedParking = false,
): Result<undefined, Refusal & { reason: "pr_delivery_running" | "commit_delivery_running" }> {
  const commit = db
    .select()
    .from(commitDeliveries)
    .where(
      and(
        eq(commitDeliveries.sourceId, sourceId),
        assignment === undefined ? undefined : eq(commitDeliveries.assignment, assignment),
      ),
    )
    .all()
    .some((row) => {
      const data = z.object({ stage: z.string() }).parse(JSON.parse(row.data));
      return !["build", "review", "complete"].includes(data.stage);
    });
  if (commit)
    return deliveryRefusal(
      "commit_delivery_running",
      "A pinned commit delivery has partial or uncertain effects. Reconcile that candidate before ending its work or creating a hold.",
    );
  const delivery = db
    .select()
    .from(deliveries)
    .where(
      and(
        eq(deliveries.sourceId, sourceId),
        assignment === undefined ? undefined : eq(deliveries.assignment, assignment),
        isNull(deliveries.endedAt),
      ),
    )
    .get();
  if (delivery !== undefined)
    return deliveryRefusal(
      "pr_delivery_running",
      "An unfinished direct merge request can still apply. Reconcile operator pr merge before changing this work or creating a hold.",
    );
  if (allowQueuedParking) return Ok(undefined);
  const queued = db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.sourceId, sourceId),
        assignment === undefined ? undefined : eq(pullRequests.assignment, assignment),
        isNull(pullRequests.mergedAt),
      ),
    )
    .all()
    .some((row) => {
      if (row.parking === null) return false;
      const parked = z
        .object({ queueHead: z.string().nullish(), state: z.string().optional() })
        .parse(JSON.parse(row.parking));
      return (
        parked.queueHead !== undefined && parked.queueHead !== null && parked.state !== "closed"
      );
    });
  return queued
    ? deliveryRefusal(
        "pr_delivery_running",
        "A durable queue attempt can still apply. Observe the parked batch outcome before changing this work or creating a hold.",
      )
    : Ok(undefined);
}

/** Unreconciled stack state excludes delivery, including parked supervisor delivery. */
export function stackIdle(
  db: Db,
  sourceId: string,
  assignment: string,
): Result<undefined, Refusal & { reason: "pr_stack_running" }> {
  const held = db
    .select()
    .from(stackOperations)
    .where(and(eq(stackOperations.sourceId, sourceId), eq(stackOperations.assignment, assignment)))
    .all()
    .some((row) => !["complete", "cancelled"].includes(row.state) || !ownerGone(row, Date.now()));
  return held
    ? deliveryRefusal(
        "pr_stack_running",
        "An unfinished stack operation owns this assignment. Reconcile its outcome before delivery.",
      )
    : Ok(undefined);
}
