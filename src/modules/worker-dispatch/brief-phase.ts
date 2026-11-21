import { WorkerKinds } from "../worker-kinds/main.ts";

type Facts = {
  kind: Parameters<typeof WorkerKinds.decidePhase>[0]["kind"] | null;
  report: { decision: "accepted" | "returned" | null } | null;
  pullRequest: { mergedAt: string | null; readiness?: object | null } | null;
  review: { state: "reviewing" | "ready" | "skipped"; rounds: number } | null;
  internalReview: boolean;
};

// Decoded record facts need not describe a reachable command history. This projection preserves
// their phase observation; it grants no transition and leaves lifecycle policy with WorkerKinds.
export function briefPhase(facts: Facts) {
  if (facts.kind === null) return undefined;
  return WorkerKinds.decidePhase({
    kind: facts.kind,
    report:
      facts.report === null
        ? null
        : {
            returned: facts.report.decision === "returned",
            accepted: facts.report.decision === "accepted",
          },
    pr: {
      associated: facts.pullRequest !== null,
      rounds: facts.review?.rounds ?? 0,
      ready: facts.pullRequest?.readiness !== undefined && facts.pullRequest.readiness !== null,
      merged: facts.pullRequest !== null && facts.pullRequest.mergedAt !== null,
      parked: false,
    },
    internalReview: facts.internalReview,
    reviewSkipped: facts.review?.state === "skipped",
    // Stryker disable next-line BooleanLiteral: equivalent: this observation has no event, so decidePhase reads worktreeClean only in guards it does not evaluate
    worktreeClean: true,
  }).phase;
}
