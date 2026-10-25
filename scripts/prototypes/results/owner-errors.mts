import { z } from "zod";
import type { StoreError } from "./store.mts";

const reasonSchema = z.enum([
  "stale-revision",
  "stale-result",
  "no-operation",
  "invalid-state",
  "invalid-event",
  "approval-required",
  "checks-not-passing",
  "unresolved-threads",
  "default-base-required",
  "dependencies-not-ready",
  "operation-pending",
  "reconcile-before-retry",
  "outcome-unknown",
  "retry-required",
  "unlanded-work",
  "wrong-completion",
  "superagent-required",
  "follow-up-required",
  "invalid-draft",
  "no-new-activity",
  "approval-stops-watching",
]);
export type Refusal = { type: "refused"; reason: z.infer<typeof reasonSchema> };
export type OwnerError = Refusal | StoreError;
export function refusal(reason: string): Refusal {
  return { type: "refused", reason: reasonSchema.parse(reason) };
}
