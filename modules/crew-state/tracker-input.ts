import { z } from "zod";
import { readStored, readStoredValue } from "./stored.ts";
import type { TrackerStep } from "./tracker.ts";

const target = z.strictObject({
  repository: z.string().min(1),
  issue: z.int().positive(),
});

const contentIdentity = z.string().regex(/^[0-9a-f]{64}$/, {
  error: "a content identity is a SHA256 digest in lower-case hexadecimal",
});

/**
 * One tracker step request.
 * A caller may restate the target it believes it is writing to. The recorded binding decides,
 * and a restatement that disagrees is refused rather than followed.
 */
export const trackerStepInputSchema = z.discriminatedUnion("step", [
  z.strictObject({
    step: z.literal("resolution"),
    target: target.optional(),
    body: z.string().min(1),
  }),
  z.strictObject({
    step: z.literal("completion"),
    target: target.optional(),
    // The close reason is part of the intended effect, so a different one is a conflict.
    reason: z.enum(["completed", "not_planned"]),
  }),
  z.strictObject({
    step: z.literal("map_amendment"),
    target: target.optional(),
    // A shared body is only replaced under a verified provider conflict guard.
    mode: z.enum(["amendment", "replace-body"]),
    decisionLink: z.string().min(1),
    baselineIdentity: contentIdentity,
    sections: z.array(z.string().min(1)).min(1),
    supersedes: z.array(z.string().min(1)),
    body: z.string().min(1),
  }),
]);

export type TrackerStepInput = z.infer<typeof trackerStepInputSchema>;

const problem = z.strictObject({ reason: z.string(), detail: z.string() });

const step: z.ZodType<TrackerStep> = z.enum(["resolution", "completion", "map_amendment"]);

const writeState = z.enum(["intended", "succeeded", "failed", "uncertain"]);

export type TrackerWriteState = z.infer<typeof writeState>;

// A tracker operation row stores these columns, and every reader takes them back through the
// schema that wrote them rather than asserting the shape it expected.
export function storedProblems(stored: string): Array<z.infer<typeof problem>> {
  return readStored("tracker problem list", z.array(problem), stored);
}

export function storedTarget(stored: string): z.infer<typeof target> {
  return readStored("tracker step target", target, stored);
}

export function storedStep(stored: string): TrackerStep {
  return readStoredValue("tracker step", step, stored);
}

export function storedWriteState(stored: string): TrackerWriteState {
  return readStoredValue("tracker write state", writeState, stored);
}
