import { z } from "zod";
import { storedPrReadinessSchema } from "./pr-readiness.ts";

const review = z.looseObject({
  sourceId: z.string(),
  assignment: z.string(),
  state: z.enum(["reviewing", "ready", "skipped"]),
  implementerLaunchId: z.string(),
  readyHead: z.string().nullable(),
  commentId: z.string().nullable(),
  commentUrl: z.string().nullable(),
});
const round = z.looseObject({
  sourceId: z.string(),
  assignment: z.string(),
  number: z.number().int().min(1).max(2),
  launchId: z.string(),
  head: z.string(),
  findings: z.string(),
});
const prior = { review: review.nullable(), rounds: z.array(round) };
const archive = z
  .strictObject({
    ...prior,
    version: z.literal(1),
    operation: z.string(),
    readinessRaw: z.string().nullable(),
    readiness: z.unknown(),
    progress: z.string(),
    parking: z.string().nullable(),
    handoff: z.record(z.string(), z.unknown()).nullable(),
  })
  .superRefine((value, context) => {
    const decoded = storedPrReadinessSchema.safeParse(value.readinessRaw);
    const typed = storedPrReadinessSchema.parse(
      value.readiness === null ? null : JSON.stringify(value.readiness),
    );
    if (!decoded.success || JSON.stringify(decoded.data) !== JSON.stringify(typed))
      context.addIssue({
        code: "custom",
        message: "Archived readiness differs from its original receipt.",
      });
  });

/** Known pre-kind archives remain history; unknown versions or malformed evidence fail closed. */
export function stackHistory(text: string) {
  return z.union([archive, z.strictObject(prior)]).parse(JSON.parse(text));
}
