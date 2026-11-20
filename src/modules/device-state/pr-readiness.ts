import { and, eq } from "drizzle-orm";
import { Err, Ok, type Result } from "unthrown";
import { z } from "zod";
import type { Db } from "./database.ts";
import { kindHandoffs, pullRequests } from "./schema.ts";
import type { Refusal } from "../../lib/cli-result.ts";

const place = { round: z.number().int().positive(), finding: z.number().int().positive() };
export const prReadinessSchema = z.object({
  head: z.string().min(1),
  at: z.string().min(1),
  note: z.string().min(1).nullable(),
  dispositions: z.array(
    z.discriminatedUnion("disposition", [
      z.object({ ...place, disposition: z.literal("applied") }),
      z.object({ ...place, disposition: z.literal("declined"), reason: z.string().trim().min(1) }),
    ]),
  ),
});
export type PrReadiness = z.infer<typeof prReadinessSchema>;

/** The storage decoder shared by coordination snapshots and PR owner reads. */
export const storedPrReadinessSchema = z
  .string()
  .nullable()
  .default(null)
  .transform((text) => (text === null ? null : prReadinessSchema.parse(JSON.parse(text))));

/** Readiness and its fresh next launch are one write, under the caller's active-owner check. */
export function recordPrReady(
  db: Db,
  target: { sourceId: string; assignment: string; launchId: string },
  readiness: PrReadiness,
  nextKind: string,
): Result<undefined, Refusal & { reason: "handoff_running" }> {
  const key = and(
    eq(kindHandoffs.sourceId, target.sourceId),
    eq(kindHandoffs.assignment, target.assignment),
  );
  const previous = db.select().from(kindHandoffs).where(key).get();
  if (previous !== undefined && previous.handoffState !== "done")
    return Err({
      reason: "handoff_running" as const,
      detail: "Finish the recorded outgoing handoff before starting another. Nothing was changed.",
      next: { command: "operator next", why: "Read the pending handoff's recovery action." },
    });
  const now = readiness.at;
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
  db.update(pullRequests)
    .set({ readiness: JSON.stringify(readiness) })
    .where(
      and(
        eq(pullRequests.sourceId, target.sourceId),
        eq(pullRequests.assignment, target.assignment),
      ),
    )
    .run();
  db.insert(kindHandoffs)
    .values(row)
    .onConflictDoUpdate({
      target: [kindHandoffs.sourceId, kindHandoffs.assignment],
      set: row,
    })
    .run();
  return Ok(undefined);
}
