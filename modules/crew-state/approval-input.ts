import { z } from "zod";

const text = z.string().min(1);

/**
 * One approval. `grantedBy` is a literal because a person is the only source of authority:
 * silence, a timeout, a general direction to finish, and an Operative report produce nothing.
 */
export const approvalInputSchema = z.strictObject({
  action: text,
  targets: z.array(text).min(1),
  scope: text,
  requestRevision: text,
  exactText: text,
  grantedBy: z.literal("human"),
});

export type ApprovalInput = z.infer<typeof approvalInputSchema>;

/** One approval question: does a recorded approval cover this exact action right now? */
export const approvalCheckSchema = z.strictObject({
  action: text,
  targets: z.array(text).min(1),
  scope: text,
  requestRevision: text,
});

export type ApprovalCheck = z.infer<typeof approvalCheckSchema>;
