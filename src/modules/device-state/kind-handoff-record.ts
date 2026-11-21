import { and, eq } from "drizzle-orm";
import { Err, Ok, type Result } from "unthrown";
import type { Db } from "./database.ts";
import { kindHandoffs } from "./schema.ts";
import type { Refusal } from "../../lib/cli-result.ts";

/** All closing transitions reserve the same outgoing launch and next-kind identity. */
export function recordKindHandoff(
  db: Db,
  target: { sourceId: string; assignment: string; launchId: string },
  nextKind: string,
  at = new Date().toISOString(),
): Result<undefined, Refusal & { reason: "handoff_running" }> {
  const key = and(
    eq(kindHandoffs.sourceId, target.sourceId),
    eq(kindHandoffs.assignment, target.assignment),
  );
  const previous = db.select().from(kindHandoffs).where(key).get();
  if (previous !== undefined && previous.handoffState !== "done")
    return Err({
      reason: "handoff_running",
      detail: "Finish the recorded outgoing handoff before starting another. Nothing was changed.",
      next: { command: "operator next", why: "Read the pending handoff's recovery action." },
    });
  const now = at;
  const row = {
    sourceId: target.sourceId,
    assignment: target.assignment,
    outgoingLaunchId: target.launchId,
    nextKind,
    handoffState: "pending",
    handoffDetail: null,
    startedAt: now,
    updatedAt: now,
    ownerPid: process.pid,
    leaseAt: now,
  };
  db.insert(kindHandoffs)
    .values(row)
    .onConflictDoUpdate({ target: [kindHandoffs.sourceId, kindHandoffs.assignment], set: row })
    .run();
  return Ok(undefined);
}
