import { z } from "zod";
import { WRITE_PATHS_GRANT_ACTION, writePathRefusal } from "./write-paths.ts";

const text = z.string().min(1);

/** The targets one approval fixed. An approval row stores them, and readers take them back. */
export const approvalTargetsSchema = z.array(text).min(1);

/**
 * One approval. `grantedBy` is a literal because a person is the only source of authority:
 * silence, a timeout, a general direction to finish, and an Operative report produce nothing.
 * The targets of a write-paths grant are read as write paths, so each one must be canonical.
 */
export const approvalInputSchema = z
  .strictObject({
    action: text,
    targets: approvalTargetsSchema,
    scope: text,
    requestRevision: text,
    exactText: text,
    grantedBy: z.literal("human"),
  })
  .superRefine((input, context) => {
    if (input.action !== WRITE_PATHS_GRANT_ACTION) {
      return;
    }
    input.targets.forEach((target, index) => {
      const refusal = writePathRefusal(target);
      if (refusal !== null) {
        context.addIssue({ code: "custom", path: ["targets", index], message: refusal });
      }
    });
  });

export type ApprovalInput = z.infer<typeof approvalInputSchema>;

/** One approval question: does a recorded approval cover this exact action right now? */
export const approvalCheckSchema = z.strictObject({
  action: text,
  targets: approvalTargetsSchema,
  scope: text,
  requestRevision: text,
});

export type ApprovalCheck = z.infer<typeof approvalCheckSchema>;
