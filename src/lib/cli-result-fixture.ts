import { expect } from "bun:test";
import { z } from "zod";
import type { ResultContext } from "./cli-result.ts";

const next = z.union([
  z.strictObject({ command: z.string().min(1), why: z.string().min(1) }),
  z.strictObject({ decider: z.enum(["person", "super-agent"]), question: z.string().min(1) }),
  z.strictObject({ why: z.string().min(1) }),
]);

/** Owning tests check nonempty recovery fields as well as each guard's specific facts. */
export function expectRefusalContext(value: ResultContext & { reason: string }) {
  z.looseObject({ next, state: z.record(z.string(), z.unknown()).optional() }).parse(value);
}
export const workflowOutputSchema = z.looseObject({
  outcome: z.string(),
  reason: z.string(),
  next: next.optional(),
});
type WorkflowOutput = z.infer<typeof workflowOutputSchema>;
/** A refusal envelope has a recovery instruction and at most three text lines. */
export function expectRefusalOutput(output: WorkflowOutput, stderr: string) {
  if (output.outcome === "completed") return;
  expect(output.next).toBeDefined();
  expect(stderr.trim().split("\n").length).toBeLessThanOrEqual(3);
  expect(stderr).toContain("next:");
}
