import { and, eq } from "drizzle-orm";
import type { Result } from "unthrown";
import { z } from "zod";
import type { Db } from "./database.ts";
import { pullRequests } from "./schema.ts";
import { recordKindHandoff } from "./kind-handoff-record.ts";
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
const persistedReadiness = z.union([
  prReadinessSchema.extend({
    origin: z.literal("migration-0026"),
    head: z.string().min(1).nullable(),
  }),
  prReadinessSchema,
]);
export type PrReadiness = z.infer<typeof persistedReadiness>;

/** The storage decoder shared by coordination snapshots and PR owner reads. */
export const storedPrReadinessSchema = z
  .string()
  .nullable()
  .default(null)
  .transform((text) => (text === null ? null : persistedReadiness.parse(JSON.parse(text))));

/** Readiness and its fresh next launch are one write, under the caller's active-owner check. */
export function recordPrReady(
  db: Db,
  target: { sourceId: string; assignment: string; launchId: string },
  readiness: PrReadiness,
  nextKind: string,
): Result<
  undefined,
  Refusal & { reason: "handoff_running" | "pr_delivery_running" | "commit_delivery_running" }
> {
  return recordKindHandoff(db, target, nextKind, readiness.at).map(() => {
    db.update(pullRequests)
      .set({ readiness: JSON.stringify(readiness) })
      .where(
        and(
          eq(pullRequests.sourceId, target.sourceId),
          eq(pullRequests.assignment, target.assignment),
        ),
      )
      .run();
    return undefined;
  });
}
