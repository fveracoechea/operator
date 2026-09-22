import { z } from "zod";
import { TrackerUpdate } from "../tracker-update/main.ts";
import { readStored, readStoredValue } from "./stored.ts";
import type { TrackerStep } from "./tracker.ts";

/** A write the contract judges. `intended` is this release's own record of one not yet sent. */
type SentState = Parameters<typeof TrackerUpdate.judge>[0]["writes"][number];

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

/** The reasons the contract knows, read at runtime so a stored one cannot drift from them. */
const known: readonly string[] = TrackerUpdate.reasons();

type TrackerReason = ReturnType<typeof TrackerUpdate.judge>["reason"];

const reason = z.custom<TrackerReason>(
  (value) => typeof value === "string" && known.includes(value),
  {
    error: "a tracker reason this release does not know",
  },
);

const problem = z.strictObject({ reason, detail: z.string() });

export type TrackerProblem = z.infer<typeof problem>;

type VerdictState = ReturnType<typeof TrackerUpdate.judge>["state"];

const verdictState: z.ZodType<VerdictState> = z.enum([
  "verified",
  "conflict",
  "uncertain",
  "pending",
  "failed",
]);

const step: z.ZodType<TrackerStep> = z.enum(["resolution", "completion", "map_amendment"]);

export type TrackerWriteState = SentState | "intended";

const writeState: z.ZodType<TrackerWriteState> = z.enum([
  "intended",
  "succeeded",
  "failed",
  "uncertain",
]);

// A tracker operation row stores these columns, and every reader takes them back through the
// schema that wrote them rather than asserting the shape it expected.
export function storedProblems(stored: string): TrackerProblem[] {
  return readStored("tracker problem list", z.array(problem), stored);
}

export function storedReason(stored: string): TrackerReason {
  return readStoredValue("tracker reason", reason, stored);
}

export function storedVerdictState(stored: string): VerdictState {
  return readStoredValue("tracker step state", verdictState, stored);
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
