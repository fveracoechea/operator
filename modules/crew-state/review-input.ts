import { z } from "zod";
import { REVIEW_AXES } from "./review.ts";

const axis = z.enum(REVIEW_AXES);

const finding = z.strictObject({
  key: z.string().min(1),
  // A blocker stops acceptance. An improvement may be deferred with a reason and a follow-up.
  severity: z.enum(["blocker", "improvement"]),
  summary: z.string().min(1),
  evidence: z.string().min(1),
});

const axisReport = z.strictObject({
  axis,
  summary: z.string().min(1),
  // The fixed inputs this axis actually read, so incomplete coverage is visible.
  checked: z.array(z.string().min(1)).min(1),
  findings: z.array(finding),
});

/**
 * One native sub-agent of the review host.
 * It carries its own window, so two axes that ran one after the other are visible as such.
 */
const subAgent = z.strictObject({
  axis,
  name: z.string().min(1),
  host: z.string().min(1),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  status: z.enum(["completed", "failed"]),
});

export const reviewReportInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("reported"),
    submissionIdentity: z.string().min(1),
    host: z.string().min(1),
    subAgents: z.array(subAgent).length(2),
    reports: z.array(axisReport).length(2),
  }),
  z.strictObject({
    kind: z.literal("blocked"),
    submissionIdentity: z.string().min(1),
    host: z.string().min(1),
    blocker: z.strictObject({
      reason: z.enum(["review_capability_unavailable", "credentials_missing", "inputs_missing"]),
      detail: z.string().min(1),
    }),
  }),
]);

export type ReviewReportInput = z.infer<typeof reviewReportInputSchema>;
export type AxisReport = z.infer<typeof axisReport>;
export type SubAgentRecord = z.infer<typeof subAgent>;

const disposition = z.discriminatedUnion("disposition", [
  z.strictObject({
    findingId: z.string().min(1),
    disposition: z.literal("corrected"),
    reason: z.string().min(1),
  }),
  z.strictObject({
    findingId: z.string().min(1),
    disposition: z.literal("rejected"),
    reason: z.string().min(1),
  }),
  z.strictObject({
    findingId: z.string().min(1),
    disposition: z.literal("deferred"),
    reason: z.string().min(1),
    // A deferred finding names where it is tracked, so nothing disappears in silence.
    followUp: z.string().min(1),
  }),
]);

export const dispositionInputSchema = z.strictObject({
  dispositions: z.array(disposition).min(1),
});

export type DispositionInput = z.infer<typeof dispositionInputSchema>;
export type FindingDisposition = z.infer<typeof disposition>;
