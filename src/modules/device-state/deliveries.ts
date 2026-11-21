import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import { Ok, type Result } from "unthrown";
import { z } from "zod";
import { WorkerKinds } from "../worker-kinds/main.ts";
import type { Refusal } from "../../lib/cli-result.ts";
import { checkHistory, transaction, type Db } from "./database.ts";
import { activeOwner } from "./pull-requests.ts";
import { storedPrReadinessSchema } from "./pr-readiness.ts";
import { ownerGone } from "./leases.ts";
import { deliveryIdle, deliveryRefusal, stackIdle } from "./delivery-guards.ts";
import {
  deliveries,
  deliveryValidations,
  kindHandoffs,
  launches,
  obligations,
  pullRequests,
} from "./schema.ts";

type Request = { launchId: string; head: string; selected: boolean; session: string | null };
const lease = z.object({
  ownerPid: z.number().nullable().default(null),
  leaseAt: z.string().nullable().default(null),
});

function prKey(sourceId: string, assignment: string) {
  return and(eq(pullRequests.sourceId, sourceId), eq(pullRequests.assignment, assignment));
}

function outstanding(db: Db, sourceId: string, assignment: string) {
  return (
    db
      .select()
      .from(deliveries)
      .where(
        and(
          eq(deliveries.sourceId, sourceId),
          eq(deliveries.assignment, assignment),
          isNull(deliveries.endedAt),
        ),
      )
      .get() ?? null
  );
}

function validation(
  db: Db,
  sourceId: string,
  assignment: string,
  head: string,
  readiness: string | null,
) {
  const ready = storedPrReadinessSchema.parse(readiness);
  if (ready === null || ready.head === null || ready.head === head) return Ok(undefined);
  const recorded = db
    .select()
    .from(deliveryValidations)
    .where(
      and(
        eq(deliveryValidations.sourceId, sourceId),
        eq(deliveryValidations.assignment, assignment),
        eq(deliveryValidations.head, head),
        eq(deliveryValidations.readiness, JSON.stringify(ready)),
      ),
    )
    .get();
  return recorded === undefined
    ? deliveryRefusal(
        "pr_validation_stale",
        "The current feedback owner must record exact-head correction evidence with operator pr validate --file <evidence.txt>. Do not repeat ready or broad review.",
      )
    : Ok(undefined);
}

/** New admission and source holds serialize under the same immediate write boundary. */
export function admitDelivery(client: Database, input: Request, direct: boolean) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) => deliveryAdmission(db, input, direct)),
  );
}

export function deliveryAdmission(db: Db, input: Request, direct: boolean) {
  return activeOwner(db, input.launchId, {
    parkedMergeHead: input.selected ? input.head : undefined,
  }).flatMap(
    ({ source, assignment, launch }): Result<typeof deliveries.$inferSelect | null, Refusal> => {
      if (input.selected && (input.session === null || source.supervisingSession !== input.session))
        return deliveryRefusal(
          "source_supervised_elsewhere",
          "Only the exact recorded supervising session may select parked delivery.",
        );
      const pr = db.select().from(pullRequests).where(prKey(source.id, assignment.key)).get();
      if (pr === undefined || pr.branch !== launch.branch)
        return deliveryRefusal(
          "pr_not_associated",
          "The current launch does not own this PR branch.",
        );
      if (storedPrReadinessSchema.parse(pr.readiness) === null)
        return deliveryRefusal(
          "pr_merge_blocked",
          "The current assignment has no ready frontier. Nothing was submitted.",
        );
      const handoff = db
        .select()
        .from(kindHandoffs)
        .where(
          and(eq(kindHandoffs.sourceId, source.id), eq(kindHandoffs.assignment, assignment.key)),
        )
        .get();
      if (
        (handoff !== undefined && handoff.handoffState !== "done") ||
        !ownerGone({ ownerPid: pr.waitOwnerPid, leaseAt: pr.waitLeaseAt }, Date.now()) ||
        (pr.relay !== null && !ownerGone(lease.parse(JSON.parse(pr.relay)), Date.now()))
      )
        return deliveryRefusal(
          "pr_owner_busy",
          "A PR wait, relay, or handoff still owns this work.",
        );
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
        return deliveryRefusal(
          "pr_merge_held",
          `The person's source merge hold ${hold.key} remains open. Wait for the person to release it.`,
        );
      return deliveryIdle(db, source.id, assignment.key)
        .flatMap(() => stackIdle(db, source.id, assignment.key))
        .flatMap(() => validation(db, source.id, assignment.key, input.head, pr.readiness))
        .map(() => {
          if (!direct) return null;
          const now = new Date().toISOString();
          const row = {
            id: crypto.randomUUID(),
            sourceId: source.id,
            assignment: assignment.key,
            launchId: launch.id,
            head: input.head,
            readiness: pr.readiness,
            selected: input.selected,
            session: input.session,
            requestUuid: null,
            startedAt: now,
            endedAt: null,
            ownerPid: process.pid,
            leaseAt: now,
          };
          db.insert(deliveries).values(row).run();
          return row;
        });
    },
  );
}

/** Assignment-keyed recovery never rewrites the original requester or readiness evidence. */
export function readDelivery(client: Database, launchId: string) {
  return transaction(client, false, () =>
    checkHistory(client).map((db) => {
      const launch = db.select().from(launches).where(eq(launches.id, launchId)).get();
      return launch === undefined ? null : outstanding(db, launch.sourceId, launch.assignment);
    }),
  );
}

export function recoverDelivery(client: Database, input: Request, id: string) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) =>
      activeOwner(db, input.launchId, {
        parkedMergeHead: input.selected ? input.head : undefined,
      }).flatMap(({ source, assignment }): Result<typeof deliveries.$inferSelect, Refusal> => {
        if (
          input.selected &&
          (input.session === null || source.supervisingSession !== input.session)
        )
          return deliveryRefusal(
            "source_supervised_elsewhere",
            "Only the recorded supervising session may reconcile selected delivery.",
          );
        const row = outstanding(db, source.id, assignment.key);
        if (row?.id !== id || !ownerGone(row, Date.now()))
          return deliveryRefusal(
            "pr_delivery_running",
            "Another process still owns delivery, or its identity changed.",
          );
        db.update(deliveries)
          .set({ ownerPid: process.pid, leaseAt: new Date().toISOString() })
          .where(eq(deliveries.id, id))
          .run();
        return Ok(row);
      }),
    ),
  );
}

/** Only the current local claim may save or release its remote request identity. */
export function changeDelivery(
  client: Database,
  id: string,
  change: { uuid?: string; finish?: boolean; suspend?: boolean },
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) => {
      const row = db
        .select()
        .from(deliveries)
        .where(
          and(
            eq(deliveries.id, id),
            eq(deliveries.ownerPid, process.pid),
            isNull(deliveries.endedAt),
          ),
        )
        .get();
      if (row === undefined)
        return deliveryRefusal(
          "pr_delivery_running",
          "The local delivery claim changed. Nothing was recorded.",
        );
      db.update(deliveries)
        .set({
          requestUuid: change.uuid ?? row.requestUuid,
          endedAt: change.finish ? new Date().toISOString() : null,
          ownerPid: change.finish || change.suspend ? null : process.pid,
          leaseAt: change.finish || change.suspend ? null : new Date().toISOString(),
        })
        .where(eq(deliveries.id, id))
        .run();
      return Ok(undefined);
    }),
  );
}

/** Exact-head evidence is independent of rounds and applies only to this ready provenance. */
export function recordDeliveryValidation(
  client: Database,
  input: { launchId: string; head: string; readiness: string; summary: string },
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) =>
      activeOwner(db, input.launchId).flatMap(
        ({
          source,
          assignment,
          launch,
        }): Result<typeof deliveryValidations.$inferSelect, Refusal> => {
          const pr = db.select().from(pullRequests).where(prKey(source.id, assignment.key)).get();
          const ready = storedPrReadinessSchema.parse(pr?.readiness ?? null);
          const readyHead = ready?.head;
          const handoff = db
            .select()
            .from(kindHandoffs)
            .where(
              and(
                eq(kindHandoffs.sourceId, source.id),
                eq(kindHandoffs.assignment, assignment.key),
              ),
            )
            .get();
          if (
            readyHead === undefined ||
            readyHead === null ||
            JSON.stringify(ready) !== input.readiness ||
            handoff?.outgoingLaunchId === launch.id ||
            launch.kind === null ||
            WorkerKinds.snapshotSchema().parse(JSON.parse(launch.kind)).name !== "pr-feedback"
          )
            return deliveryRefusal(
              "pr_validation_stale",
              "The current feedback owner or readiness provenance changed. Nothing was recorded.",
            );
          return deliveryIdle(db, source.id, assignment.key)
            .flatMap(() => stackIdle(db, source.id, assignment.key))
            .map(() => {
              const row = {
                id: crypto.randomUUID(),
                sourceId: source.id,
                assignment: assignment.key,
                ...input,
                validatedAt: new Date().toISOString(),
              };
              db.insert(deliveryValidations).values(row).run();
              return row;
            });
        },
      ),
    ),
  );
}
