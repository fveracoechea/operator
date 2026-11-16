import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import { Err, Ok, type Result } from "unthrown";
import { z } from "zod";
import type { NextStep } from "../../lib/cli-result.ts";
import { checkHistory, transaction, type Db } from "./database.ts";
import { activeOwner } from "./pull-requests.ts";
import {
  deliveries,
  deliveryValidations,
  internalReviews,
  launches,
  obligations,
  pullRequests,
} from "./schema.ts";
import { ownerGone } from "./leases.ts";

type Request = {
  launchId: string;
  head: string;
  session: string | null;
  selected: boolean;
  reconcile?: boolean;
  resumeId?: string;
};
type Failure = { reason: string; detail: string; next: NextStep };
type Active = Extract<ReturnType<typeof activeOwner>, { tag: "Ok" }>["value"];
const relayClaim = z.object({
  ownerPid: z.number().int().nullable().default(null),
  leaseAt: z.string().nullable().default(null),
});

function refused(reason: string, detail: string) {
  return Err<Failure>({
    reason,
    detail: `${detail} Nothing was merged or removed.`,
    next: {
      decider: "super-agent",
      question:
        "How should this delivery blocker be resolved without bypassing ownership, holds, or current evidence?",
    },
  });
}

function available(db: Db, owner: Active, input: Request) {
  const { source, assignment, launch } = owner;
  const hold = db
    .select()
    .from(obligations)
    .where(
      and(
        eq(obligations.sourceId, source.id),
        eq(obligations.kind, "merge-hold"),
        eq(obligations.state, "open"),
      ),
    )
    .get();
  if (hold !== undefined)
    return refused(
      "pr_merge_held",
      `The person's merge hold ${hold.key} remains open. Wait for the person to release it.`,
    );
  const pr = db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.sourceId, source.id), eq(pullRequests.assignment, assignment.key)))
    .get();
  if (pr === undefined || pr.branch !== launch.branch)
    return refused("pr_not_associated", "The launch does not own this PR branch.");
  if (input.selected && launch.activity !== "idle")
    return refused(
      "pr_owner_busy",
      "The PR owner is not recorded idle. Ask the owner to finish its active work first.",
    );
  if (!ownerGone({ ownerPid: pr.waitOwnerPid, leaseAt: pr.waitLeaseAt }, Date.now()))
    return refused("pr_owner_busy", "A PR wait is active. Stop that job before delivery.");
  if (pr.relay !== null && !ownerGone(relayClaim.parse(JSON.parse(pr.relay)), Date.now()))
    return refused(
      "pr_owner_busy",
      "A parent relay holds this branch. Wait for it to finish before delivery.",
    );
  return Ok(undefined);
}

function provenance(db: Db, owner: Active, input: Request) {
  const review = db
    .select()
    .from(internalReviews)
    .where(
      and(
        eq(internalReviews.sourceId, owner.source.id),
        eq(internalReviews.assignment, owner.assignment.key),
      ),
    )
    .get();
  if (review === undefined) return Ok(null);
  // Reconciliation records an observed external merge; it submits no merge request.
  if (input.reconcile) return Ok(review.readyHead);
  if (!["ready", "skipped"].includes(review.state))
    return refused("pr_merge_blocked", "The internal review has not ended.");
  if (review.readyHead === input.head) return Ok(review.readyHead);
  if (review.readyHead === null)
    return refused(
      "pr_validation_stale",
      "The ended review has no recorded ready head. Reconcile its provenance before delivery.",
    );
  const validation = db
    .select()
    .from(deliveryValidations)
    .where(
      and(
        eq(deliveryValidations.launchId, input.launchId),
        eq(deliveryValidations.head, input.head),
        eq(deliveryValidations.readyHead, review.readyHead),
      ),
    )
    .get();
  return validation === undefined
    ? refused(
        "pr_validation_stale",
        "This head has no bounded-correction validation tied to the ready head. The owner must run operator pr validate --file <evidence.txt> --json.",
      )
    : Ok(review.readyHead);
}

/** Authority, holds, active work, and competing deliveries are checked in one claim transaction. */
export function claimDelivery(client: Database, input: Request) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) =>
      activeOwner(db, input.launchId).flatMap(
        (owner): Result<typeof deliveries.$inferSelect, Failure> => {
          if (
            input.selected &&
            (input.session === null || owner.source.supervisingSession !== input.session)
          )
            return refused(
              "source_supervised_elsewhere",
              "Only this source's recorded supervising session may select delivery.",
            );
          return available(db, owner, input)
            .flatMap(() => provenance(db, owner, input))
            .flatMap((readyHead) => {
              const claimed = db
                .select({ delivery: deliveries })
                .from(deliveries)
                .innerJoin(launches, eq(launches.id, deliveries.launchId))
                .where(
                  and(
                    eq(launches.sourceId, owner.source.id),
                    eq(launches.assignment, owner.assignment.key),
                    isNull(deliveries.endedAt),
                  ),
                )
                .get();
              const previous = claimed?.delivery;
              if (input.resumeId !== undefined && previous?.id !== input.resumeId)
                return refused(
                  "pr_delivery_running",
                  "The outstanding delivery changed during reconciliation. Read its current outcome before retrying.",
                );
              if (previous !== undefined) {
                if (input.reconcile && ownerGone(previous, Date.now())) {
                  db.update(deliveries)
                    .set({ ownerPid: process.pid, leaseAt: new Date().toISOString() })
                    .where(eq(deliveries.id, previous.id))
                    .run();
                  return Ok(previous);
                }
                return refused(
                  "pr_delivery_running",
                  "An earlier delivery remains unfinished. Reconcile its remote outcome before another delivery.",
                );
              }
              const now = new Date().toISOString();
              const row = {
                id: crypto.randomUUID(),
                launchId: input.launchId,
                head: input.head,
                session: input.session,
                selected: input.selected,
                readyHead,
                ownerPid: process.pid,
                leaseAt: now,
                startedAt: now,
                endedAt: null,
                requestUuid: null,
              };
              db.insert(deliveries).values(row).run();
              return Ok(row);
            });
        },
      ),
    ),
  );
}

/** An unfinished external request remains a blocker even after its local process has ended. */
export function readDelivery(client: Database, launchId: string) {
  return transaction(client, false, () =>
    checkHistory(client).map((db) => {
      const launch = db.select().from(launches).where(eq(launches.id, launchId)).get();
      if (launch === undefined) return null;
      return (
        db
          .select({ delivery: deliveries })
          .from(deliveries)
          .innerJoin(launches, eq(launches.id, deliveries.launchId))
          .where(
            and(
              eq(launches.sourceId, launch.sourceId),
              eq(launches.assignment, launch.assignment),
              isNull(deliveries.endedAt),
            ),
          )
          .get()?.delivery ?? null
      );
    }),
  );
}

/** Save the remote request identity before another read; never overwrite the original actor. */
export function recordDeliveryRequest(client: Database, launchId: string, uuid: string) {
  // Stryker disable next-line BooleanLiteral: equivalent: every path writes, so a deferred transaction reaches the same writer reservation before any result
  return transaction(client, true, () =>
    checkHistory(client).map((db) => {
      db.update(deliveries)
        .set({ requestUuid: uuid })
        .where(
          and(
            eq(deliveries.launchId, launchId),
            eq(deliveries.ownerPid, process.pid),
            isNull(deliveries.endedAt),
          ),
        )
        .run();
      return undefined;
    }),
  );
}

/** Stop local ownership without pretending an uncertain external request has finished. */
export function suspendDelivery(client: Database, launchId: string) {
  // Stryker disable next-line BooleanLiteral: equivalent: every path writes, so a deferred transaction reaches the same writer reservation before any result
  return transaction(client, true, () =>
    checkHistory(client).map((db) => {
      db.update(deliveries)
        .set({ ownerPid: null, leaseAt: null })
        .where(
          and(
            eq(deliveries.launchId, launchId),
            eq(deliveries.ownerPid, process.pid),
            isNull(deliveries.endedAt),
          ),
        )
        .run();
      return undefined;
    }),
  );
}

/** Release only this process's claim, retaining the head and caller as delivery evidence. */
export function finishDelivery(client: Database, launchId: string, head: string) {
  // Stryker disable next-line BooleanLiteral: equivalent: every path writes, so a deferred transaction reaches the same writer reservation before any result
  return transaction(client, true, () =>
    checkHistory(client).map((db) => {
      db.update(deliveries)
        .set({ endedAt: new Date().toISOString(), ownerPid: null, leaseAt: null })
        .where(
          and(
            eq(deliveries.launchId, launchId),
            eq(deliveries.head, head),
            eq(deliveries.ownerPid, process.pid),
            isNull(deliveries.endedAt),
          ),
        )
        .run();
      return undefined;
    }),
  );
}

/** Keep a long external merge request claimed until this process releases it. */
export function renewDelivery(client: Database, launchId: string) {
  // Stryker disable next-line BooleanLiteral: equivalent: every path writes, so a deferred transaction reaches the same writer reservation before any result
  return transaction(client, true, () =>
    checkHistory(client).map((db) => {
      db.update(deliveries)
        .set({ leaseAt: new Date().toISOString() })
        .where(
          and(
            eq(deliveries.launchId, launchId),
            eq(deliveries.ownerPid, process.pid),
            isNull(deliveries.endedAt),
          ),
        )
        .run();
      return undefined;
    }),
  );
}

/** Retain validation separately; the ready head and actual review-round heads never change. */
export function recordDeliveryValidation(
  client: Database,
  input: { launchId: string; head: string; readyHead: string; summary: string },
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) =>
      activeOwner(db, input.launchId).flatMap(({ source, assignment }) => {
        const review = db
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
          review === undefined ||
          !["ready", "skipped"].includes(review.state) ||
          review.readyHead !== input.readyHead
        )
          return refused(
            "pr_validation_stale",
            "The recorded review provenance changed. Read the assignment before validating again.",
          );
        const row = { id: crypto.randomUUID(), ...input, validatedAt: new Date().toISOString() };
        db.insert(deliveryValidations).values(row).run();
        return Ok(row);
      }),
    ),
  );
}
