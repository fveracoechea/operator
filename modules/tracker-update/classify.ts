import type { TrackerStep } from "./provider.ts";

/**
 * The provider-neutral reasons one tracker step reports.
 * They are the approved identifiers of the tracker contract, so provider detail travels beside
 * a reason rather than inside it.
 */
export const TRACKER_REASONS = [
  "tracker.completed",
  "tracker.read_failed",
  "tracker.write_rejected",
  "tracker.invalid_request",
  "tracker.capability_unavailable",
  "tracker.approval_required",
  "tracker.evidence_incomplete",
  "tracker.resolution_conflict",
  "tracker.completion_conflict",
  "tracker.map_conflict",
  "tracker.resolution_outcome_unknown",
  "tracker.completion_outcome_unknown",
  "tracker.map_outcome_unknown",
  "tracker.pending",
] as const;

export type TrackerReason = (typeof TRACKER_REASONS)[number];

/** One marked comment the tracker actually holds, with the identity of the content it carries. */
export type CommentMark = {
  commentId: string;
  url: string;
  actor: string;
  createdAt: string;
  updatedAt: string;
  contentIdentity: string;
};

export type ScanCoverage = {
  complete: boolean;
  pages: number;
  count: number;
  detail: string | null;
};

export type CommentObservation = {
  kind: "comment";
  /** A known server identifier is read directly; otherwise every accessible page is scanned. */
  lookup: "known-id" | "scan";
  coverage: ScanCoverage;
  exactMatches: CommentMark[];
  editedMatches: CommentMark[];
  actorMismatches: CommentMark[];
  observedAt: string;
};

export type ClosureEvent = {
  event: string;
  actor: string | null;
  stateReason: string | null;
  createdAt: string;
};

export type ClosureObservation = {
  kind: "closure";
  read: "found" | "absent" | "unknown";
  detail: string | null;
  state: string | null;
  stateReason: string | null;
  closedBy: string | null;
  closedAt: string | null;
  updatedAt: string | null;
  events: ClosureEvent[];
  /** A reopen after the most recent close. It stops automatic closure and needs a decision. */
  reopenedAfterClose: boolean;
  observedAt: string;
};

export type Observation = CommentObservation | ClosureObservation;

export type WriteAttemptState = "intended" | "succeeded" | "failed" | "uncertain";

export type Problem = { reason: TrackerReason; detail: string };

export type VerdictState = "verified" | "conflict" | "uncertain" | "pending" | "failed";

export type Verdict = {
  state: VerdictState;
  reason: TrackerReason;
  problems: Problem[];
};

const conflictReason = {
  resolution: "tracker.resolution_conflict",
  completion: "tracker.completion_conflict",
  map_amendment: "tracker.map_conflict",
} as const satisfies Record<TrackerStep, TrackerReason>;

const unknownReason = {
  resolution: "tracker.resolution_outcome_unknown",
  completion: "tracker.completion_outcome_unknown",
  map_amendment: "tracker.map_outcome_unknown",
} as const satisfies Record<TrackerStep, TrackerReason>;

/**
 * The order the contract fixes for an operation that holds several problems.
 * An unproven external effect outranks everything, because acting on a lower-ranked reading
 * would decide a question the evidence has not answered.
 */
const PRECEDENCE: TrackerReason[] = [
  "tracker.resolution_outcome_unknown",
  "tracker.completion_outcome_unknown",
  "tracker.map_outcome_unknown",
  "tracker.resolution_conflict",
  "tracker.completion_conflict",
  "tracker.map_conflict",
  "tracker.capability_unavailable",
  "tracker.approval_required",
  "tracker.evidence_incomplete",
  "tracker.read_failed",
  "tracker.write_rejected",
  "tracker.pending",
];

const stateByReason: Record<TrackerReason, VerdictState> = {
  "tracker.completed": "verified",
  "tracker.read_failed": "failed",
  "tracker.write_rejected": "failed",
  "tracker.invalid_request": "failed",
  "tracker.capability_unavailable": "pending",
  "tracker.approval_required": "pending",
  "tracker.evidence_incomplete": "pending",
  "tracker.resolution_conflict": "conflict",
  "tracker.completion_conflict": "conflict",
  "tracker.map_conflict": "conflict",
  "tracker.resolution_outcome_unknown": "uncertain",
  "tracker.completion_outcome_unknown": "uncertain",
  "tracker.map_outcome_unknown": "uncertain",
  "tracker.pending": "pending",
};

/** Chooses the overall result. Every problem is kept; only the ranking picks the reason. */
export function decide(problems: Problem[]): Verdict {
  const ranked = PRECEDENCE.find((reason) => problems.some((one) => one.reason === reason));
  const reason = ranked ?? "tracker.completed";
  return { state: stateByReason[reason], reason, problems };
}

/**
 * What a step with no matching evidence is, read from its write history alone.
 * Nothing sent is pending work, a lost answer is an unproven effect, and a tracker that refused
 * every request is a definite failure. A read that went badly never changes which of these it is.
 */
function unsentOrUnproven(request: { writes: WriteAttemptState[]; step: TrackerStep }): Problem[] {
  const sent = request.writes.filter((state) => state !== "intended");
  if (sent.length === 0) {
    return [{ reason: "tracker.pending", detail: "This step has not been written yet." }];
  }
  if (sent.includes("uncertain")) {
    return [
      {
        reason: unknownReason[request.step],
        detail:
          "A write of this step never returned a definite answer, and nothing observed satisfies it yet. It may still apply.",
      },
    ];
  }
  if (sent.every((state) => state === "failed")) {
    return [
      {
        reason: "tracker.write_rejected",
        detail: "Every write of this step was refused by the tracker, and nothing satisfies it.",
      },
    ];
  }

  return [];
}

function commentProblems(request: {
  step: TrackerStep;
  observation: CommentObservation;
  writes: WriteAttemptState[];
}): Problem[] {
  const { observation, step } = request;
  const problems: Problem[] = [];

  if (observation.exactMatches.length > 1) {
    problems.push({
      reason: conflictReason[step],
      detail: `The tracker holds ${observation.exactMatches.length} comments under this operation. A person selects the authoritative one.`,
    });
  }
  if (observation.editedMatches.length > 0) {
    problems.push({
      reason: conflictReason[step],
      detail:
        "A comment under this operation carries content that is not the intended content. A later edit is reviewed, never restored automatically.",
    });
  }
  if (observation.actorMismatches.length > 0) {
    problems.push({
      reason: conflictReason[step],
      detail: `A comment under this operation was written by ${observation.actorMismatches.map((one) => one.actor).join(", ")}, which is not the expected actor.`,
    });
  }

  if (observation.exactMatches.length === 1 && problems.length === 0) {
    return problems;
  }

  // A read that did not cover everything proves nothing about what it did not see.
  if (!observation.coverage.complete) {
    problems.push({
      reason: "tracker.evidence_incomplete",
      detail:
        observation.coverage.detail ??
        "The comment scan did not cover every accessible page, so a missing match is not absence.",
    });
  }

  if (observation.exactMatches.length > 0) {
    return problems;
  }

  // A comment the reading did not cover is not a comment that was removed, so only a complete
  // reading can say that an accepted write left nothing behind.
  const sent = request.writes.filter((state) => state !== "intended");
  if (sent.includes("succeeded") && observation.coverage.complete) {
    problems.push({
      reason: conflictReason[step],
      detail:
        "A write of this step was accepted, and no comment under this operation is present now. It was removed or changed outside Operator.",
    });
    return problems;
  }

  return [...problems, ...unsentOrUnproven({ writes: request.writes, step })];
}

function closureProblems(request: {
  observation: ClosureObservation;
  intendedReason: string;
  writes: WriteAttemptState[];
}): Problem[] {
  const { observation } = request;
  const problems: Problem[] = [];

  if (observation.read === "unknown") {
    problems.push({
      reason: "tracker.evidence_incomplete",
      detail: observation.detail ?? "The ticket state could not be read.",
    });
  }
  if (observation.read === "absent") {
    problems.push({
      reason: "tracker.read_failed",
      detail: "The tracker holds no such ticket, so its completion cannot be observed.",
    });
    return problems;
  }

  if (observation.reopenedAfterClose) {
    problems.push({
      reason: "tracker.completion_conflict",
      detail:
        "The ticket was reopened after it was closed. Automatic closure stops and a new decision is required.",
    });
  }

  if (observation.state === "closed") {
    if (observation.stateReason === request.intendedReason) {
      return problems;
    }

    problems.push({
      reason: "tracker.completion_conflict",
      detail: `The ticket is closed as ${observation.stateReason ?? "no stated reason"}, and this step intends ${request.intendedReason}.`,
    });
    return problems;
  }

  // A request that was never sent has no effect that may still apply, however the read went.
  return [...problems, ...unsentOrUnproven({ writes: request.writes, step: "completion" })];
}

/**
 * Turns one step's intent, its write history, and what the tracker actually shows into a verdict.
 * It is pure, so the same evidence always reads the same way, and a failed read never becomes
 * proof that a write did not apply.
 */
export function judge(request: {
  step: TrackerStep;
  observation: Observation;
  intendedReason: string;
  writes: WriteAttemptState[];
  extra?: Problem[];
}): Verdict {
  const problems =
    request.observation.kind === "comment"
      ? commentProblems({
          step: request.step,
          observation: request.observation,
          writes: request.writes,
        })
      : closureProblems({
          observation: request.observation,
          intendedReason: request.intendedReason,
          writes: request.writes,
        });

  return decide([...(request.extra ?? []), ...problems]);
}
