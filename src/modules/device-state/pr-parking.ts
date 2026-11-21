import { and, eq, desc } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import { Err, Ok, fromThrowable, type Result } from "unthrown";
import { z } from "zod";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { checkHistory, transaction, type Db } from "./database.ts";
import { activeOwner } from "./pull-requests.ts";
import { storedPrReadinessSchema, type PrReadiness } from "./pr-readiness.ts";
import { stateFailure, type StateFailure } from "./failures.ts";
import { recordKindHandoff } from "./kind-handoff-record.ts";
import { validateContinuation, type HandoffContinuation } from "./handoff-continuation.ts";
import { ownerGone } from "./leases.ts";
import { migrationParkingFacts } from "./migration-receipts.ts";
import { deliveryAdmission } from "./deliveries.ts";
import { decideParking, type ParkingFacts } from "./pr-parking-machine.ts";
import {
  assignments,
  kindHandoffs,
  launches,
  parkedPrReads,
  pullRequests,
  sources,
} from "./schema.ts";
import type { Refusal } from "../../lib/cli-result.ts";
import type { Supervisor } from "./sources.ts";

const parkingReceipt = z.object({
  launchId: z.string(),
  head: z.string(),
  at: z.string(),
  note: z.string().nullable(),
  state: z.enum(["parking", "parked", "resuming", "active", "closed"]),
  events: z.array(z.string()),
  parentSeen: z.boolean().default(false),
  // The guarded queue attempt owns batch completion, even if its response is lost.
  queueHead: z.string().nullable().optional(),
});
export const prParkingSchema = z.union([
  parkingReceipt.extend({
    origin: z.literal("migration-0026"),
    head: z.string().nullable(),
    launchId: z.string().nullable(),
  }),
  parkingReceipt,
]);
export type PrParking = z.infer<typeof prParkingSchema>;
type Target = { repository: string; sourceId: string; assignment: string };

function qualifyReadiness<T>(cause: Error, defect: (cause: Error) => T) {
  return cause instanceof SyntaxError || cause instanceof z.ZodError
    ? stateFailure("state_corrupt", "The recorded PR readiness is invalid. Nothing was changed.", {
        readinessValid: false,
      })
    : defect(cause);
}

function readReadiness(text: string | null): Result<PrReadiness | null, StateFailure> {
  return fromThrowable(
    () => storedPrReadinessSchema.parse(text),
    (cause, defect) => (cause instanceof Error ? qualifyReadiness(cause, defect) : defect(cause)),
  )();
}
function key(target: { sourceId: string; assignment: string }) {
  return and(
    eq(pullRequests.sourceId, target.sourceId),
    eq(pullRequests.assignment, target.assignment),
  );
}
function refused(): Refusal & { reason: "pr_resume_refused" } {
  return {
    reason: "pr_resume_refused",
    detail: "This assignment has no actionable parked PR transition. Nothing changed.",
    next: { command: "operator next", why: "Read the recorded PR action." },
  };
}

function facts(state: PrParking["state"] | null): ParkingFacts {
  return {
    event: "park",
    state,
    ready: false,
    feedbackOwner: false,
    repositoryMatches: true,
    sourceOpen: true,
    assignmentOpen: true,
    launchMatches: false,
    launchFinished: false,
    leaseOwned: false,
    outgoingMatches: false,
    hasEvents: false,
    migrationOrigin: false,
    historicalOwnerIdle: false,
    historicalLaunchState: null,
  };
}

/** Persist the batch-owned lifecycle before an enqueue can take effect or lose its response. */
export function recordPullRequestQueue(
  client: Database,
  launchId: string,
  head: string,
  actor = { selected: false, session: null as string | null },
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) =>
      deliveryAdmission(db, { launchId, head, ...actor }, false).flatMap(() =>
        activeOwner(db, launchId, { parkedMergeHead: head }).flatMap(
          ({ source, assignment, launch }): Result<undefined, Refusal> => {
            const row = db
              .select()
              .from(pullRequests)
              .where(key({ sourceId: source.id, assignment: assignment.key }))
              .get();
            if (row === undefined || assignment.state !== "pr-open" || row.branch !== launch.branch)
              return Err(refused());
            const previous =
              row.parking === null ? null : prParkingSchema.parse(JSON.parse(row.parking));
            const parking: PrParking = previous ?? {
              launchId,
              head,
              at: new Date().toISOString(),
              note: null,
              state: "active",
              events: [],
              parentSeen: false,
            };
            db.update(pullRequests)
              .set({ parking: JSON.stringify({ ...parking, queueHead: head }) })
              .where(key(row))
              .run();
            return Ok(undefined);
          },
        ),
      ),
    ),
  );
}

export function parkPullRequest(
  client: Database,
  launchId: string,
  input: { head: string; note: string | null },
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) =>
      activeOwner(db, launchId).flatMap((owner): Result<PrParking, Refusal> => {
        const row = db
          .select()
          .from(pullRequests)
          .where(key({ sourceId: owner.source.id, assignment: owner.assignment.key }))
          .get();
        if (row === undefined) return Err(refused());
        return readReadiness(row.readiness).flatMap((readiness): Result<PrParking, Refusal> => {
          const previous =
            row.parking === null ? null : prParkingSchema.parse(JSON.parse(row.parking));
          const decision = decideParking({
            ...facts(previous?.state ?? null),
            ready: readiness !== null,
            feedbackOwner:
              owner.launch.kind !== null &&
              WorkerKinds.snapshotSchema().parse(JSON.parse(owner.launch.kind)).name ===
                "pr-feedback",
          });
          if (decision.result !== "transition") return Err(refused());
          return recordKindHandoff(
            db,
            { sourceId: owner.source.id, assignment: owner.assignment.key, launchId },
            "pr-feedback",
            undefined,
            true,
          ).map(() => {
            const parking: PrParking = {
              launchId,
              ...input,
              at: new Date().toISOString(),
              state: decision.state,
              events: [],
              queueHead: previous?.queueHead ?? null,
              parentSeen:
                row.parking === null
                  ? false
                  : prParkingSchema.parse(JSON.parse(row.parking)).parentSeen,
            };
            db.update(pullRequests)
              .set({
                parking: JSON.stringify(parking),
                waitState: "idle",
                waitOwnerPid: null,
                waitLeaseAt: null,
              })
              .where(key(row))
              .run();
            return parking;
          });
        });
      }),
    ),
  );
}

/** Called by the generic outgoing handoff after pane closure and launch end. */
export function completeParking(
  client: Database,
  target: Target,
  continuation?: HandoffContinuation,
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) =>
      validateContinuation(db, continuation, target).flatMap(() => {
        const row = db.select().from(pullRequests).where(key(target)).get();
        if (row?.parking === null || row === undefined) return Ok(false);
        const text = row.parking;
        return readReadiness(row.readiness).flatMap(() => {
          const parking = prParkingSchema.parse(JSON.parse(text));
          const decision = decideParking(
            parkingCompletionFacts(db, target, parking, row.repository),
          );
          if (decision.result === "unchanged") return Ok(false);
          if (decision.result === "refused") return Err(refused());
          db.update(pullRequests)
            .set({ parking: JSON.stringify({ ...parking, state: decision.state }) })
            .where(key(target))
            .run();
          db.update(kindHandoffs)
            .set({ handoffState: "done", ownerPid: null, leaseAt: null })
            .where(
              and(
                eq(kindHandoffs.sourceId, target.sourceId),
                eq(kindHandoffs.assignment, target.assignment),
              ),
            )
            .run();
          return Ok(true);
        });
      }),
    ),
  );
}

function parkingCompletionFacts(
  db: Db,
  target: Target,
  parking: PrParking,
  repository: string,
): ParkingFacts {
  const source = db.select().from(sources).where(eq(sources.id, target.sourceId)).get();
  const assignment = db
    .select()
    .from(assignments)
    .where(and(eq(assignments.sourceId, target.sourceId), eq(assignments.key, target.assignment)))
    .get();
  const latest = db
    .select()
    .from(launches)
    .where(and(eq(launches.sourceId, target.sourceId), eq(launches.assignment, target.assignment)))
    .orderBy(desc(launches.attempt))
    .get();
  const handoff = db
    .select()
    .from(kindHandoffs)
    .where(
      and(
        eq(kindHandoffs.sourceId, target.sourceId),
        eq(kindHandoffs.assignment, target.assignment),
      ),
    )
    .get();
  return {
    ...facts(parking.state),
    event: "complete",
    repositoryMatches: repository === target.repository && source?.repository === repository,
    sourceOpen: source?.state === "open",
    assignmentOpen: assignment?.state === "pr-open",
    launchMatches: latest?.id === parking.launchId,
    launchFinished: latest?.state === "finished",
    leaseOwned: handoff?.ownerPid === process.pid,
    outgoingMatches: handoff?.outgoingLaunchId === parking.launchId,
  };
}

function resumeAuthorityRefusal(
  kind: string | null,
  supervisorSession: string | null,
  fillKind: string | undefined,
  callerSession: string | null,
): Refusal | null {
  if (fillKind !== undefined && kind !== null)
    return {
      reason: "assignment_kind_set",
      detail: "The assignment already has a kind. Nothing changed.",
      next: { command: "operator next", why: "Use the recorded assignment kind." },
      state: { kind },
    };
  if (supervisorSession !== null && supervisorSession !== callerSession)
    return {
      reason: "source_supervised_elsewhere",
      detail: "Another agent session now supervises this source. Nothing changed.",
      next: {
        decider: "super-agent",
        question:
          "Will the recorded supervisor continue, or should the person authorize a source take-over?",
      },
      state: { supervisorSession, callerSession },
    };
  return null;
}

export function resumeParkedPullRequest(
  client: Database,
  target: Target,
  fillKind?: string,
  supervisor: Supervisor = { pane: null, session: null },
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db): Result<undefined, Refusal> => {
      const row = db
        .select()
        .from(pullRequests)
        .where(and(key(target), eq(pullRequests.repository, target.repository)))
        .get();
      const assignment = db
        .select()
        .from(assignments)
        .where(
          and(eq(assignments.sourceId, target.sourceId), eq(assignments.key, target.assignment)),
        )
        .get();
      const source = db.select().from(sources).where(eq(sources.id, target.sourceId)).get();
      if (
        row?.parking === null ||
        row === undefined ||
        assignment?.state !== "pr-open" ||
        source?.state !== "open"
      )
        return Err(refused());
      const authority = resumeAuthorityRefusal(
        assignment.kind,
        source.supervisingSession,
        fillKind,
        supervisor.session,
      );
      if (authority !== null) return Err(authority);
      const text = row.parking;
      return readReadiness(row.readiness).flatMap((): Result<undefined, Refusal> => {
        const parking = prParkingSchema.parse(JSON.parse(text));
        const latest = db
          .select()
          .from(launches)
          .where(
            and(eq(launches.sourceId, target.sourceId), eq(launches.assignment, target.assignment)),
          )
          .orderBy(desc(launches.attempt))
          .get();
        const decision = decideParking({
          ...facts(parking.state),
          ...migrationParkingFacts(db, latest, parking),
          event: "resume",
          hasEvents: parking.events.length > 0,
          launchMatches: latest?.id === parking.launchId,
          launchFinished: latest?.state === "finished",
        });
        if (decision.result !== "transition") return Err(refused());
        if ("origin" in parking) {
          db.update(pullRequests)
            .set({ parking: JSON.stringify({ ...parking, state: decision.state }) })
            .where(key(target))
            .run();
          return Ok(undefined);
        }
        return recordKindHandoff(db, { ...target, launchId: parking.launchId }, "pr-feedback").map(
          () => {
            db.update(pullRequests)
              .set({ parking: JSON.stringify({ ...parking, state: decision.state }) })
              .where(key(target))
              .run();
            return undefined;
          },
        );
      });
    }),
  );
}

/** Reserve already checked the source, assignment and latest outgoing launch in this transaction. */
export function activateParking(
  db: Db,
  target: Target,
  outgoing: { id: string } | undefined,
): Result<undefined, ReturnType<typeof refused> | StateFailure> {
  const row = db.select().from(pullRequests).where(key(target)).get();
  return readReadiness(row?.readiness ?? null).flatMap(() => {
    const parking =
      row?.parking === null || row === undefined
        ? null
        : prParkingSchema.parse(JSON.parse(row.parking));
    const decision = decideParking({
      ...facts(parking?.state ?? null),
      event: "activate",
      repositoryMatches: row === undefined || row.repository === target.repository,
      launchMatches: parking?.launchId === outgoing?.id,
    });
    if (decision.result === "refused") return Err(refused());
    if (decision.result === "transition" && parking !== null)
      db.update(pullRequests)
        .set({ parking: JSON.stringify({ ...parking, state: decision.state }) })
        .where(key(target))
        .run();
    return Ok(undefined);
  });
}

export function claimParkedRead(client: Database, now: number) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) => {
      const row = db.select().from(parkedPrReads).where(eq(parkedPrReads.id, 1)).get();
      if (
        row !== undefined &&
        (!ownerGone(row, now) ||
          (row.lastReadAt !== null && now - Date.parse(row.lastReadAt) < 900000))
      )
        return Ok(null);
      const at = new Date(now).toISOString();
      const claim = {
        id: 1,
        lastReadAt: row?.lastReadAt ?? null,
        ownerPid: process.pid,
        leaseAt: at,
      };
      db.insert(parkedPrReads)
        .values(claim)
        .onConflictDoUpdate({ target: parkedPrReads.id, set: claim })
        .run();
      const rows = db
        .select({ pr: pullRequests })
        .from(pullRequests)
        .innerJoin(
          assignments,
          and(
            eq(assignments.sourceId, pullRequests.sourceId),
            eq(assignments.key, pullRequests.assignment),
          ),
        )
        .innerJoin(sources, eq(sources.id, pullRequests.sourceId))
        .where(and(eq(assignments.state, "pr-open"), eq(sources.state, "open")))
        .all()
        .flatMap(({ pr }) => {
          if (pr.parking === null) return [];
          const parking = prParkingSchema.parse(JSON.parse(pr.parking));
          return parking.state === "parked" ? [{ ...pr, parkingRaw: pr.parking, parking }] : [];
        });
      return fromThrowable(
        () => ({
          at,
          rows: rows.map((row) => ({
            ...row,
            readiness: storedPrReadinessSchema.parse(row.readiness),
          })),
        }),
        (cause, defect) =>
          cause instanceof Error ? qualifyReadiness(cause, defect) : defect(cause),
      )();
    }),
  );
}

type ParkedUpdate = {
  sourceId: string;
  assignment: string;
  previous: string;
  progress: string;
  parking: PrParking;
};
export function finishParkedRead(client: Database, at: string, updates: ParkedUpdate[] | null) {
  return transaction(client, true, () =>
    checkHistory(client).map((db) => {
      const claim = db.select().from(parkedPrReads).where(eq(parkedPrReads.id, 1)).get();
      if (claim?.ownerPid !== process.pid || claim.leaseAt !== at) return false;
      if (updates !== null)
        for (const update of updates) {
          const current = db.select().from(pullRequests).where(key(update)).get();
          if (current?.parking !== update.previous) return false;
          if (update.parking.state === "closed") {
            const previous = prParkingSchema.parse(JSON.parse(update.previous));
            const decision = decideParking({ ...facts(previous.state), event: "close" });
            if (decision.result !== "transition") return false;
          }
        }
      if (updates !== null)
        for (const update of updates)
          db.update(pullRequests)
            .set({ progress: update.progress, parking: JSON.stringify(update.parking) })
            .where(and(key(update), eq(pullRequests.parking, update.previous)))
            .run();
      db.update(parkedPrReads)
        .set({
          lastReadAt: updates === null ? claim.lastReadAt : at,
          ownerPid: null,
          leaseAt: null,
        })
        .where(eq(parkedPrReads.id, 1))
        .run();
      return true;
    }),
  );
}
