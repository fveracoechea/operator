import { z } from "zod";
import { codeRevisionsSchema, resultKindSchema, submittedCheckSchema } from "./submission-input.ts";
import { storedArtifactSchema } from "./submission-store.ts";
import { readStored, readStoredValue } from "./stored.ts";

/**
 * Two things the rework must settle that pull against each other.
 * The Operator names the conflict and delegates it. It records no resolution of its own,
 * because resolving it here would decide the work instead of assigning it.
 */
const conflict = z.strictObject({
  summary: z.string().min(1),
  between: z.array(z.string().min(1)).min(2),
});

/** One revision this cycle combines with the submitted result. */
const combined = z.strictObject({
  name: z.string().min(1),
  revision: z.string().min(1),
});

const stated = {
  instruction: z.string().min(1),
  conflicts: z.array(conflict),
};

/** The three reasons a cycle is delegated. A stored reason is read back through this. */
export const reworkReasonSchema = z.enum(["findings", "integration", "diagnostic"]);

export function storedReworkReason(stored: string): ReworkReason {
  return readStoredValue("rework reason", reworkReasonSchema, stored);
}

/**
 * Why one rework cycle is delegated.
 * Accepted corrections and a combined revision are correction work and share one limit.
 * A diagnostic rerun changes nothing and carries its own, smaller limit.
 */
export const reworkInputSchema = z.discriminatedUnion("reason", [
  z.strictObject({
    ...stated,
    reason: z.literal("findings"),
    reviewId: z.string().min(1),
  }),
  z.strictObject({
    ...stated,
    reason: z.literal("integration"),
    // A revision can need combining before any review reported, so this names one only when
    // the Operator is answering that review as well.
    reviewId: z.string().min(1).optional(),
    combines: z.array(combined).min(1),
  }),
  z.strictObject({
    ...stated,
    reason: z.literal("diagnostic"),
    // The recorded checks a test infrastructure failure is suspected behind.
    checks: z.array(z.string().min(1)).min(1),
  }),
]);

export type ReworkInput = z.infer<typeof reworkInputSchema>;
export type ReworkReason = z.infer<typeof reworkReasonSchema>;
export type ReworkConflict = z.infer<typeof conflict>;

/** One accepted correction, carried with the evidence the reviewer recorded for it. */
const correction = z.strictObject({
  findingId: z.string(),
  axis: z.string(),
  key: z.string(),
  severity: z.string(),
  summary: z.string(),
  evidence: z.string(),
  reason: z.string(),
});

export type ReworkCorrection = z.infer<typeof correction>;

/**
 * Everything the fresh Operative receives about the result it reworks.
 * It is written once, when the cycle is delegated, so a later change to the review or the
 * submission cannot change the brief the Operative was given.
 */
export const reworkBriefSchema = z.strictObject({
  reason: reworkReasonSchema,
  cycleIndex: z.int().positive(),
  limit: z.int().positive(),
  // The approval that let this cycle run past the limit, when the user directed one.
  approvalId: z.string().nullable(),
  instruction: z.string(),
  reviewId: z.string().nullable(),
  submissionId: z.string(),
  submissionIdentity: z.string(),
  resultKind: resultKindSchema,
  corrections: z.array(correction),
  conflicts: z.array(conflict),
  combines: z.array(combined),
  checks: z.array(submittedCheckSchema),
  code: codeRevisionsSchema.nullable(),
  artifacts: z.array(storedArtifactSchema),
});

export type ReworkBriefRecord = z.infer<typeof reworkBriefSchema>;

// A rework cycle row stores this column, and every reader takes it back through the schema that
// wrote it rather than asserting the shape it expected.
export function storedReworkBrief(stored: string): ReworkBriefRecord {
  return readStored("rework brief", reworkBriefSchema, stored);
}
