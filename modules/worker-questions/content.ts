import { z } from "zod";

/** The worker's question. The key names it within the assignment, so a retry cannot ask twice. */
export const questionSchema = z.strictObject({
  key: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters and digits joined by single hyphens.")
    .max(64),
  question: z.string().trim().min(1).max(4000),
});

/** The SuperAgent's answer text, read from a file so that it keeps its own quoting. */
export const answerSchema = z.string().trim().min(1).max(4000);
