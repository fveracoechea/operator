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
const migrated = new Set([
  "dispatch",
  "source",
  "next",
  "report",
  "question",
  "message",
  "obligation",
  "cleanup",
]);

/** Every existing workflow refusal exercised by a CLI fixture also checks its recovery contract. */
export function expectWorkflowRefusal(args: string[], output: WorkflowOutput, stderr: string) {
  if (!migrated.has(String(args[0])) && !(args[0] === "internal-review" && args[1] === "skip"))
    return;
  if (output.outcome === "completed") return;
  expect(output.next).toBeDefined();
  expect(stderr.trim().split("\n").length).toBeLessThanOrEqual(3);
  expect(stderr).toContain("next:");
}
