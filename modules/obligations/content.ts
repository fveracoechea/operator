import { z } from "zod";

/**
 * What the SuperAgent can owe the person: a PR to share for review, a review reply to send, a
 * merge to hold, a standing rule the person gave, and a person's decision that waits to be
 * recorded on the work it decides.
 */
export const kinds = [
  "pr-share",
  "review-reply",
  "merge-hold",
  "standing-rule",
  "person-decision",
] as const;

/** The SuperAgent's file. The key names the obligation within its source, so a retry cannot add it twice. */
export const obligationSchema = z.strictObject({
  key: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters and digits joined by single hyphens.")
    .max(64),
  kind: z.enum(kinds),
  summary: z.string().trim().min(1).max(2000),
  reference: z.string().trim().min(1).max(2000).optional(),
});
