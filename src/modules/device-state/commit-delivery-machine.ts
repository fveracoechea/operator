import type { z } from "zod";
import type { commitDeliverySchema } from "./commit-deliveries.ts";

type Data = z.infer<typeof commitDeliverySchema>;
type Event =
  | "record_build"
  | "record_review"
  | "admit_delivery"
  | "verify_checkout"
  | "verify_local"
  | "verify_publication"
  | "finalize";

const transitions: { from: Data["stage"] | null; event: Event }[] = [
  { from: null, event: "record_build" },
  { from: "build", event: "record_review" },
  { from: "review", event: "admit_delivery" },
  { from: "checkout", event: "verify_checkout" },
  { from: "local", event: "verify_local" },
  { from: "remote", event: "verify_publication" },
  { from: "finalize", event: "finalize" },
];
const events: Record<Data["stage"], Event> = {
  build: "record_build",
  review: "record_review",
  checkout: "admit_delivery",
  local: "verify_checkout",
  remote: "verify_local",
  finalize: "verify_publication",
  complete: "finalize",
};

function retained(previous: unknown[], next: unknown[]) {
  return JSON.stringify(previous) === JSON.stringify(next.slice(0, previous.length));
}

function candidateProgress(previous: Data, next: Data) {
  const before = previous.candidate;
  const after = next.candidate;
  if (before === null) return true;
  if (after === null) return false;
  const { head: beforeHead, ...beforeIdentity } = before;
  const { head: afterHead, ...afterIdentity } = after;
  if (JSON.stringify(beforeIdentity) === JSON.stringify(afterIdentity))
    return beforeHead === null || beforeHead === afterHead;
  return (
    afterHead === null &&
    before.path !== after.path &&
    before.branch !== after.branch &&
    before.tree !== after.tree
  );
}

function preservesEvidence(previous: Data, next: Data) {
  return (
    retained(previous.journal, next.journal) &&
    retained(previous.history, next.history) &&
    retained(previous.rounds, next.rounds) &&
    retained(previous.dispositions, next.dispositions) &&
    (previous.implementer === null || previous.implementer === next.implementer) &&
    (previous.publishedHead === null || previous.publishedHead === next.publishedHead)
  );
}

/** The state owner allows forward events and append-only observations, never evidence resets. */
export function decideCommitDelivery(previous: Data | null, next: Data): boolean {
  const event = events[next.stage];
  const allowed =
    previous?.stage === next.stage ||
    transitions.some((row) => row.from === (previous?.stage ?? null) && row.event === event);
  if (!allowed) return false;
  if (previous === null) return true;
  if (!preservesEvidence(previous, next)) return false;
  if (previous.stage === "build" || previous.stage === "review")
    return candidateProgress(previous, next);
  return (
    JSON.stringify([
      previous.candidate,
      previous.checks,
      previous.rounds,
      previous.dispositions,
    ]) === JSON.stringify([next.candidate, next.checks, next.rounds, next.dispositions])
  );
}
