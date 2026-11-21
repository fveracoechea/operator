import { and, desc, eq } from "drizzle-orm";
import { Err, Ok } from "unthrown";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { Refusal } from "../../lib/cli-result.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { PrStacks } from "../pr-stacks/main.ts";
import { checkHistory, transaction, type Db } from "./database.ts";
import { ownerGone } from "./leases.ts";
import { reviewHandoffTarget } from "./handoff-target.ts";
import { readRecoveryReceipt } from "./internal-review-recovery.ts";
import { storedPrReadinessSchema } from "./pr-readiness.ts";
import {
  assignments,
  kindHandoffs,
  launches,
  pullRequests,
  sources,
  stackOperations,
  internalReviews,
} from "./schema.ts";

export type HandoffContinuation = {
  repository: string;
  sourceId: string;
  assignment: string;
  outgoingLaunchId: string;
  startedAt: string;
  nextKind: string;
  pane: string;
  socket: string;
};
export type ContinuationTarget = Pick<
  HandoffContinuation,
  "repository" | "sourceId" | "assignment"
>;
export type ContinuationContext = { pane: string | null; socket: string | null };

export function continuationRefusal(): Refusal & { reason: "handoff_continuation_refused" } {
  return {
    reason: "handoff_continuation_refused",
    detail:
      "This process no longer owns the exact pending kind handoff. No continuation effect was authorized.",
    next: {
      command: "operator next",
      why: "The supervisor can recover the recorded failed or stopped handoff.",
    },
    state: { continuationAuthorized: false },
  };
}

/** Trusted-device PID/lease checks, not process-incarnation or worker-session authentication. */
export function inspectContinuation(
  db: Db,
  target: ContinuationTarget,
  context: ContinuationContext,
  options: { publishingPid?: number; expected?: HandoffContinuation } = {},
) {
  const { pane, socket } = context;
  if (pane === null || socket === null) return Err(continuationRefusal());
  const recorded = db
    .select({ source: sources, assignment: assignments, handoff: kindHandoffs })
    .from(kindHandoffs)
    .innerJoin(sources, eq(sources.id, kindHandoffs.sourceId))
    .innerJoin(
      assignments,
      and(
        eq(assignments.sourceId, kindHandoffs.sourceId),
        eq(assignments.key, kindHandoffs.assignment),
      ),
    )
    .where(
      and(
        eq(sources.repository, target.repository),
        eq(kindHandoffs.sourceId, target.sourceId),
        eq(kindHandoffs.assignment, target.assignment),
      ),
    )
    .get();
  if (recorded === undefined) return Err(continuationRefusal());
  const { source, assignment, handoff } = recorded;
  const latest = db
    .select()
    .from(launches)
    .where(and(eq(launches.sourceId, target.sourceId), eq(launches.assignment, target.assignment)))
    .orderBy(desc(launches.attempt))
    .get();
  if (!continuationFacts(db, { source, assignment, handoff, latest, context: { pane, socket } }))
    return Err(continuationRefusal());
  const identity: HandoffContinuation = {
    ...target,
    outgoingLaunchId: handoff.outgoingLaunchId,
    startedAt: handoff.startedAt,
    nextKind: handoff.nextKind,
    pane,
    socket,
  };
  if (options.expected !== undefined && !sameContinuation(identity, options.expected))
    return Err(continuationRefusal());
  if (handoff.ownerPid === process.pid) return Ok({ identity, published: true });
  const { publishingPid = 0 } = options;
  return publishingPid > 0 && handoff.ownerPid === publishingPid
    ? Ok({ identity, published: false })
    : Err(continuationRefusal());
}

export function readContinuation(
  client: Database,
  target: ContinuationTarget,
  context: ContinuationContext,
  publishingPid: number,
) {
  return transaction(client, false, () =>
    checkHistory(client).flatMap((db) =>
      inspectContinuation(db, target, context, { publishingPid }),
    ),
  );
}

export function validateContinuation(
  db: Db,
  identity: HandoffContinuation | undefined,
  target?: ContinuationTarget,
) {
  if (identity === undefined) return Ok(undefined);
  return inspectContinuation(
    db,
    target ?? identity,
    { pane: identity.pane, socket: identity.socket },
    { expected: identity },
  ).flatMap((checked) => (checked.published ? Ok(undefined) : Err(continuationRefusal())));
}

export function reservedContinuation(
  db: Db,
  continuation: HandoffContinuation | undefined,
  repository: string,
  launch: { sourceId: string; assignment: string; kind?: string | null },
) {
  return validateContinuation(db, continuation, {
    repository,
    sourceId: launch.sourceId,
    assignment: launch.assignment,
  }).flatMap(() => {
    if (continuation === undefined) return Ok(undefined);
    if (launch.kind === null || launch.kind === undefined) return Err(continuationRefusal());
    return WorkerKinds.snapshotSchema().parse(JSON.parse(launch.kind)).name ===
      continuation.nextKind
      ? Ok(undefined)
      : Err(continuationRefusal());
  });
}

function sameContinuation(left: HandoffContinuation, right: HandoffContinuation) {
  return (
    left.repository === right.repository &&
    left.sourceId === right.sourceId &&
    left.assignment === right.assignment &&
    left.outgoingLaunchId === right.outgoingLaunchId &&
    left.startedAt === right.startedAt &&
    left.nextKind === right.nextKind &&
    left.pane === right.pane &&
    left.socket === right.socket
  );
}

type ContinuationFacts = {
  source: typeof sources.$inferSelect;
  assignment: typeof assignments.$inferSelect;
  handoff: typeof kindHandoffs.$inferSelect;
  latest: typeof launches.$inferSelect | undefined;
  context: { pane: string; socket: string };
};

function continuationFacts(db: Db, facts: ContinuationFacts) {
  const { source, assignment, handoff, latest } = facts;
  if (
    source.state !== "open" ||
    assignment.completion !== "pr" ||
    assignment.state !== "pr-open" ||
    handoff.handoffState !== "pending"
  )
    return false;
  if (
    latest === undefined ||
    latest.id !== handoff.outgoingLaunchId ||
    !["running", "interrupted", "finished"].includes(latest.state)
  )
    return false;
  return freshLease(handoff) && continuationOwner(db, facts, latest);
}

function readyContinuation(db: Db, facts: ContinuationFacts, latest: typeof launches.$inferSelect) {
  const { source, assignment, handoff } = facts;
  const pr = db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.sourceId, source.id), eq(pullRequests.assignment, assignment.key)))
    .get();
  if (
    pr?.readiness === null ||
    pr?.readiness === undefined ||
    pr.repository !== source.repository ||
    pr.branch !== latest.branch
  )
    return false;
  const ready = storedPrReadinessSchema.parse(pr.readiness);
  return (
    ready !== null &&
    ready.at === handoff.startedAt &&
    Date.parse(latest.startedAt) <= Date.parse(ready.at)
  );
}

function continuationOwner(db: Db, facts: ContinuationFacts, latest: typeof launches.$inferSelect) {
  const { source, assignment, handoff, context } = facts;
  if (context.socket !== latest.herdrSocket) return false;
  const receipt = readRecoveryReceipt(db, source.repository, source.id, assignment.key);
  if (receipt.tag !== "Ok") return false;
  const recovered =
    receipt.value?.implementerLaunchId === latest.id && handoff.nextKind === "review";
  if (context.pane !== latest.paneId && (context.pane !== source.supervisingPane || !recovered))
    return false;
  if (handoff.nextKind === "pr-feedback") return feedbackContinuation(db, facts, latest);
  // An explicitly recovered promotion can retain its original report-kind snapshot.
  if (recovered) return true;
  if (stackReviewContinuation(db, facts, latest)) return true;
  return kindContinuation(db, facts, latest);
}

/** A completed changed integration permits review without changing the outgoing kind snapshot. */
function stackReviewContinuation(
  db: Db,
  facts: ContinuationFacts,
  latest: typeof launches.$inferSelect,
) {
  if (facts.handoff.nextKind !== "review" || facts.assignment.completion !== "pr") return false;
  const review = db
    .select()
    .from(internalReviews)
    .where(
      and(
        eq(internalReviews.sourceId, facts.source.id),
        eq(internalReviews.assignment, facts.assignment.key),
      ),
    )
    .get();
  if (review?.state !== "reviewing" || review.implementerLaunchId !== latest.id) return false;
  const operations = db
    .select()
    .from(stackOperations)
    .where(
      and(
        eq(stackOperations.sourceId, facts.source.id),
        eq(stackOperations.assignment, facts.assignment.key),
        eq(stackOperations.launchId, latest.id),
        eq(stackOperations.state, "complete"),
      ),
    )
    .all();
  return operations.some((row) => {
    const plan = PrStacks.operation(row.data);
    return (
      row.reviewHistory !== null &&
      plan.step === "complete" &&
      plan.launchId === latest.id &&
      plan.branch === latest.branch &&
      plan.repository === facts.source.repository &&
      plan.candidate !== null
    );
  });
}

function feedbackContinuation(
  db: Db,
  facts: ContinuationFacts,
  latest: typeof launches.$inferSelect,
) {
  if (
    latest.kind !== null &&
    WorkerKinds.snapshotSchema().parse(JSON.parse(latest.kind)).name === "pr-feedback"
  )
    return kindContinuation(db, facts, latest);
  return readyContinuation(db, facts, latest);
}

function kindContinuation(db: Db, facts: ContinuationFacts, latest: typeof launches.$inferSelect) {
  const { source, assignment, handoff } = facts;
  if (latest.kind !== null) {
    const outgoing = WorkerKinds.snapshotSchema().parse(JSON.parse(latest.kind));
    if (outgoing.completion !== assignment.completion) return false;
    if (outgoing.name === "pr-feedback" && handoff.nextKind === "pr-feedback") {
      const row = db
        .select()
        .from(pullRequests)
        .where(
          and(eq(pullRequests.sourceId, source.id), eq(pullRequests.assignment, assignment.key)),
        )
        .get();
      const parking =
        row?.parking === null || row?.parking === undefined
          ? null
          : z.object({ launchId: z.string(), state: z.string() }).parse(JSON.parse(row.parking));
      return parking?.launchId === latest.id && ["parking", "resuming"].includes(parking.state);
    }
    return reviewHandoffTarget(outgoing) === handoff.nextKind;
  }
  return reviewHandoffTarget(null) === handoff.nextKind;
}

function freshLease(handoff: typeof kindHandoffs.$inferSelect) {
  const now = Date.now();
  const timestamp = Date.parse(String(handoff.leaseAt));
  return Number.isFinite(timestamp) && timestamp <= now && !ownerGone(handoff, now);
}
