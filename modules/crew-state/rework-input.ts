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

// A cycle carries no free instruction (ADR 0008). Each reason renders one fixed sentence that the
// release owns, so an input that names an instruction refuses as invalid.
const stated = {
  conflicts: z.array(conflict),
};

/**
 * The four reasons a cycle opens. A stored reason is read back through this.
 * The Operator delegates the first three. An invalidation opens its own cycle, because the open
 * invalidation is the cycle (ADR 0008), so `work rework` never names it.
 */
export const reworkReasonSchema = z.enum(["findings", "integration", "diagnostic", "invalidation"]);

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
    // The revisions it combines are facts the CLI reads from the landing plan (ADR 0020), so the
    // input names none, and an input that names one refuses as invalid.
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

/** The defect found in an accepted result, in the words of whoever found it. */
export const defectInputSchema = z.strictObject({
  summary: z.string().min(1),
  evidence: z.string().min(1),
  foundBy: z.string().min(1),
});

export type DefectInput = z.infer<typeof defectInputSchema>;

/**
 * What an invalidation cycle corrects, fixed when the defect is recorded.
 * A code correction takes the place of the landed commit, so it starts on the parent of that
 * commit (ADR 0020). A non-code result lands nothing, so both commits are null.
 */
const invalidation = z.strictObject({
  invalidationId: z.string(),
  defect: defectInputSchema,
  landedCommit: z.string().nullable(),
  startCommit: z.string().nullable(),
});

export type ReworkInvalidation = z.infer<typeof invalidation>;

/**
 * Why a result no longer lands as it was reviewed, read from the landing plan when an
 * integration cycle is delegated (ADR 0020, ADR 0021): a conflict, a changed patch, or a planned
 * commit that failed or was flaky at the project gate.
 */
export const integrationCauseSchema = z.enum([
  "conflict",
  "patch-changed",
  "gate-failed",
  "gate-flaky",
]);

/**
 * What an integration cycle combines, fixed when it is delegated. The submitted commit and the
 * tip it lands on are the only revisions, and a failed gate run is carried with its output.
 */
const integration = z.strictObject({
  branch: z.string(),
  tip: z.string(),
  commit: z.string(),
  cause: integrationCauseSchema,
  // The paths of a conflict, and none for every other cause.
  paths: z.array(z.string()),
  gateRunId: z.string().nullable(),
  // The landed commit that a correction replaces, when the cycle answers a rewrite (ADR 0020).
  // Its tip is then the parent of that commit.
  replaces: z.string().optional(),
});

export type ReworkIntegration = z.infer<typeof integration>;

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
  // An earlier release recorded the free instruction of a cycle. It never reaches a brief.
  instruction: z.string().optional(),
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
  // Present only on an invalidation cycle. A brief that an earlier release recorded has none.
  invalidation: invalidation.optional(),
  // Present only on an integration cycle that read a landing plan. An earlier release named the
  // revisions in its input and recorded none.
  integration: integration.optional(),
});

export type ReworkBriefRecord = z.infer<typeof reworkBriefSchema>;

// A rework cycle row stores this column, and every reader takes it back through the schema that
// wrote it rather than asserting the shape it expected.
export function storedReworkBrief(stored: string): ReworkBriefRecord {
  return readStored("rework brief", reworkBriefSchema, stored);
}
