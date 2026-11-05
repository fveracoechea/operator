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

/** The SuperAgent's steering message. The key names it within the assignment, like a question key. */
export const messageSchema = z.strictObject({
  key: questionSchema.shape.key,
  message: z.string().trim().min(1).max(4000),
});

/** The worker's reply to a steering message, read from a file like an answer. */
export const replySchema = answerSchema;

/** A question's answer travels as the steering message with this key. No sent key has a colon. */
export function answerKey(questionKey: string) {
  return `answer:${questionKey}`;
}

/**
 * The fixed line that the CLI types into the worker's pane. It names the record and carries no
 * instruction, so a garbled or repeated doorbell changes nothing.
 */
export function doorbell(key: string) {
  return `Operator recorded steering message ${key} for you.`;
}
