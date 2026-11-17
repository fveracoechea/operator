import { and, desc, eq } from "drizzle-orm";
import { Err, Ok } from "unthrown";
import type { Database } from "bun:sqlite";
import type { Refusal } from "../../lib/cli-result.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { checkHistory, transaction, type Db } from "./database.ts";
import { ownerGone } from "./leases.ts";
import { assignments, kindHandoffs, launches, sources } from "./schema.ts";

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
  if (!continuationFacts({ source, assignment, handoff, latest, context: { pane, socket } }))
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
  return options.publishingPid !== undefined &&
    options.publishingPid > 0 &&
    handoff.ownerPid === options.publishingPid
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

function continuationFacts(facts: {
  source: typeof sources.$inferSelect;
  assignment: typeof assignments.$inferSelect;
  handoff: typeof kindHandoffs.$inferSelect;
  latest: typeof launches.$inferSelect | undefined;
  context: { pane: string; socket: string };
}) {
  const { source, assignment, handoff, latest, context } = facts;
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
  if (context.pane !== latest.paneId || context.socket !== latest.herdrSocket) return false;
  if (!freshLease(handoff)) return false;
  const next = WorkerKinds.names().find((name) => name === handoff.nextKind);
  return next !== undefined && WorkerKinds.resolve(next).completion === assignment.completion;
}

function freshLease(handoff: typeof kindHandoffs.$inferSelect) {
  const now = Date.now();
  const timestamp = Date.parse(handoff.leaseAt ?? "");
  return Number.isFinite(timestamp) && timestamp <= now && !ownerGone(handoff, now);
}
