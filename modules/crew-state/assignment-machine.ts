import type { AssignmentRow, AssignmentState } from "./assignment.ts";
import type { DirectionRecord } from "./direction.ts";
import type { OutsideChangeRow } from "./outside-changes.ts";
import type { StoredEntry } from "./planning-input.ts";
import type { PreparedRecord, RecordRefusal } from "./planning-record.ts";
import { type ReviewBlocker, storedBlocker, storedObservedChecks } from "./review-input.ts";
import { Review } from "./review-machine.ts";
import {
  missingAxes,
  type ReviewFindingRow,
  type ReviewReportRow,
  type ReviewRow,
} from "./review.ts";
import type { LimitKind } from "./rework.ts";
import { storedChecks } from "./submission-input.ts";
import type { SubmissionRow } from "./submission.ts";
import { isExecutable, isReview } from "./work-input.ts";

/**
 * The assignment machine (ADR 0023, ADR 0007, ADR 0008). One `assignments` row moves through
 * `AssignmentState`. A claim starts registered or invalidated work, a submit hands a result over,
 * a rework cycle sends it back, an acceptance unblocks a dependent, an invalidation finds an
 * accepted result defective, a pause holds the work that read it, a resume releases that work,
 * a withdrawal ends it, and a rewrite that takes out a landed commit reopens its acceptance.
 * The rework cycle, the invalidation, and the direction request are its correction facts.
 */
export type AssignmentEvent =
  | "claim"
  | "submit"
  | "rework"
  | "invalidate"
  | "pause"
  | "resume"
  | "accept"
  | "withdraw"
  | "reopen";

/** The states of one rework cycle. Only an open cycle is delegated work. */
export type ReworkCycleState = "open" | "submitted" | "accepted" | "merged" | "withdrawn";

/** The states of one invalidation. Only an open invalidation holds the work that read it. */
export type InvalidationState = "open" | "resolved" | "merged" | "withdrawn";

/** The states of one direction request. Only an open request waits on the user. */
export type DirectionRequestState = "open" | "directed" | "withdrawn";

/** The state each open correction record of the assignment closes to with one move. */
export type CorrectionClose = {
  cycle?: ReworkCycleState;
  invalidation?: InvalidationState;
  direction?: DirectionRequestState;
};

/** One reason the frontier withholds an assignment from dispatch. */
export type FrontierBlocker =
  | { reason: "dependency_pending"; dependencies: Array<{ assignmentId: string; state: string }> }
  | { reason: "review_pending"; reviewAssignmentId: string | null }
  | { reason: "direction_required"; directionRequestId: string; limitKind: LimitKind }
  | { reason: "input_invalidated"; invalidated: string[] }
  | { reason: "write_paths_overlap"; holders: WritePathHolder[]; command: string }
  | {
      // The integration branch of the source still holds the commit of withdrawn work, so no
      // dispatch base may hold a commit that no assignment owns until the take-out (ADR 0004).
      reason: "take_out_pending";
      commits: Array<{ assignmentId: string; commit: string }>;
    }
  | { reason: "review_capacity_reserved"; productionLimit: number }
  | { reason: "crew_at_capacity"; limit: number };

/**
 * One assignment whose held write paths overlap the paths of a withheld one. `started` work
 * holds from its first claim, and `offered` work holds inside the one reading that offered it.
 * The Operator reads this, so it gives the number of overlapping pairs of paths and the blocker names the
 * command that lists them.
 */
export type WritePathHolder = {
  assignmentId: string;
  sourceKey: string;
  hold: "started" | "offered";
  pathPairCount: number;
};

type Stale = { status: "stale-revision"; assignmentId: string; recordedRevision: number };
type NotClaimed = { status: "not-claimed"; assignmentId: string; state: string };
type Dependency = { assignmentId: string; state: string };

export type ClaimRefusal =
  | Stale
  | { status: "planning-only"; assignmentId: string; kind: string }
  | { status: "already-accepted"; assignmentId: string }
  | { status: "withdrawn"; assignmentId: string }
  | { status: "already-claimed"; assignmentId: string; attemptId: string }
  | { status: "not-dispatchable"; assignmentId: string; blockers: FrontierBlocker[] };

export type ReworkRefusal =
  | Stale
  | { status: "cycle-open"; assignmentId: string; cycleId: string; reason: string }
  | { status: "not-awaiting-review"; assignmentId: string; state: string };

export type InvalidateRefusal =
  | Stale
  | { status: "not-accepted"; assignmentId: string; state: string }
  | { status: "review-not-invalidated"; assignmentId: string }
  | {
      // The commit of the result merged into the target, so it is never invalidated (decision 24).
      status: "merged";
      assignmentId: string;
      commit: string;
      pullRequest: number | null;
      url: string | null;
    };

/** The refusals of an acceptance, in the order the table checks them. */
export type AcceptRefusal =
  | Stale
  | NotClaimed
  | { status: "direction-required"; assignmentId: string; directions: DirectionRecord[] }
  | { status: "input-invalidated"; assignmentId: string; invalidated: string[] }
  | { status: "attempt-required"; assignmentId: string }
  | { status: "attempt-not-expected"; assignmentId: string }
  | { status: "dependency-pending"; assignmentId: string; dependencies: Dependency[] }
  | { status: "planning-record-required"; assignmentId: string }
  | { status: "planning-record-not-expected"; assignmentId: string }
  | RecordRefusal
  | { status: "attempt-mismatch"; assignmentId: string; attemptId: string | null }
  | { status: "question-open"; assignmentId: string; questionId: string; state: string }
  | { status: "submission-required"; assignmentId: string }
  | { status: "submission-mismatch"; assignmentId: string; recordedSubmissionId: string }
  | {
      status: "review-incomplete";
      assignmentId: string;
      reviewId: string | null;
      state: string;
      blocker: ReviewBlocker | null;
    }
  | { status: "review-axes-incomplete"; assignmentId: string; reviewId: string; missing: string[] }
  | { status: "findings-undisposed"; assignmentId: string; reviewId: string; findingIds: string[] }
  | { status: "rework-pending"; assignmentId: string; reviewId: string; findingIds: string[] }
  | {
      status: "checks-unproven";
      assignmentId: string;
      checks: Array<{ name: string; outcome: string }>;
    }
  | {
      status: "checks-contradicted";
      assignmentId: string;
      reviewId: string;
      checks: Array<{ name: string; axis: string; recorded: string; observed: string }>;
    }
  | {
      status: "outside-changes-undisposed";
      assignmentId: string;
      submissionId: string;
      changeIds: string[];
      // How many of them touch a security permission, which only the user releases.
      security: number;
    };

/** The move a correction or a person made on this assignment does not apply to its state. */
type Unmoved = { status: "unmoved"; assignmentId: string; state: string };

/** The review a code or non-code submission reads, with what it recorded. */
export type SubmissionReview = {
  row: ReviewRow;
  findings: ReviewFindingRow[];
  reports: ReviewReportRow[];
};

type AcceptCommon = {
  row: AssignmentRow;
  /** The revision the caller states it read. */
  revision: number;
  attemptId: string | null;
  record: PreparedRecord | null;
  /** The open direction requests of the assignment. */
  directions: DirectionRecord[];
  /** The invalidated results this assignment read, while a pause holds it. */
  invalidated: string[];
};

/** The question that holds the stated attempt, or null when none waits. */
type Question = { id: string; state: string } | null;

/**
 * What an acceptance reads, by the kind of work. Planning work is decided by the Operator with
 * no attempt, review work is complete once its own reports exist, and production work is
 * accepted only from its reviewed submission. A merged acceptance takes back an invalidated
 * result whose commit merged before any recall (decision 24).
 */
export type AcceptFacts =
  | (AcceptCommon & {
      kind: "planning";
      unmet: Dependency[];
      /** The check of the stated record, or null when none is stated. */
      checked: { status: "checked"; entries: StoredEntry[] } | RecordRefusal | null;
    })
  | (AcceptCommon & {
      kind: "review";
      question: Question;
      live: { id: string } | null;
      review: ReviewRow | null;
    })
  | (AcceptCommon & {
      kind: "production";
      question: Question;
      submissionId: string | null;
      /** The latest submission, its review, and its outside changes, or null with none. */
      produced: {
        submission: SubmissionRow;
        review: SubmissionReview | null;
        outside: OutsideChangeRow[];
      } | null;
    })
  | { kind: "merged"; row: AssignmentRow };

/** What each event reads before it decides. The read of the row refuses an unknown one. */
export type AssignmentFacts = {
  claim: {
    row: AssignmentRow;
    revision: number;
    live: { id: string } | null;
    /** What the frontier did with this assignment. The frontier owns the dispatch rules. */
    offered: "dispatchable" | "planning" | { blockers: FrontierBlocker[] };
  };
  submit: { row: AssignmentRow };
  rework: { row: AssignmentRow; revision: number; open: { id: string; reason: string } | null };
  invalidate: {
    row: AssignmentRow;
    revision: number;
    /** The merged part that holds the landed commit, or null when it is not merged. */
    merged: { commit: string; pullRequest: number | null; url: string | null } | null;
  };
  pause: { row: AssignmentRow };
  resume: {
    row: AssignmentRow;
    /** What the work was doing before any pause, as its invalidation recorded it. */
    consumed: AssignmentState;
    /** Resolved by an accepted correction, or merged with no correction. */
    cause: "resolved" | "merged";
    submitted: boolean;
    /** True while another open invalidation still holds this work. */
    held: boolean;
  };
  accept: AcceptFacts;
  /** An item is withdrawn from its parent, and a holder is a review of it that closes with it. */
  withdraw: { row: AssignmentRow; as: "item" | "holder" };
  reopen: { row: AssignmentRow };
};

export type AssignmentRefusal = {
  claim: ClaimRefusal;
  submit: NotClaimed;
  rework: ReworkRefusal;
  invalidate: InvalidateRefusal;
  pause: Unmoved;
  resume: Unmoved;
  accept: AcceptRefusal;
  withdraw: Unmoved;
  reopen: Unmoved;
};

/** The next state of each event, with the correction records it closes. */
export type AssignmentNext = {
  [E in AssignmentEvent]: { state: AssignmentState; closes: CorrectionClose };
};

type Guard<F, R> = (facts: F) => R | null;

function stale(row: AssignmentRow, revision: number): Stale | null {
  return row.revision === revision
    ? null
    : { status: "stale-revision", assignmentId: row.id, recordedRevision: row.revision };
}

/** A guard that the assignment holds one of these states, or the refusal it gives. */
function from<R>(
  states: AssignmentState[],
  refusal: (row: AssignmentRow) => R,
): Guard<{ row: AssignmentRow }, R> {
  return ({ row }) => (states.some((one) => one === row.state) ? null : refusal(row));
}

function unmoved(row: AssignmentRow): Unmoved {
  return { status: "unmoved", assignmentId: row.id, state: row.state };
}

function notClaimed(row: AssignmentRow): NotClaimed {
  return { status: "not-claimed", assignmentId: row.id, state: row.state };
}

const CLAIM_GUARDS: Array<Guard<AssignmentFacts["claim"], ClaimRefusal>> = [
  ({ row }) =>
    row.state === "accepted" ? { status: "already-accepted", assignmentId: row.id } : null,
  // A withdrawal is terminal, so no attempt of withdrawn work ever starts again.
  ({ row }) => (row.state === "withdrawn" ? { status: "withdrawn", assignmentId: row.id } : null),
  // A duplicate claim names the attempt that already holds this assignment, before it reports
  // the revision, because the holder is what a caller racing for this work needs to know.
  ({ row, live }) =>
    live === null ? null : { status: "already-claimed", assignmentId: row.id, attemptId: live.id },
  // The caller states the revision it inspected, so a state that moved under it is refused.
  ({ row, revision }) => stale(row, revision),
  // The frontier owns the dispatch rules, so a claim can never take work the frontier withheld.
  ({ row, offered }) => {
    if (offered === "dispatchable") return null;
    return offered === "planning"
      ? { status: "planning-only", assignmentId: row.id, kind: row.kind }
      : { status: "not-dispatchable", assignmentId: row.id, blockers: offered.blockers };
  },
];

const REWORK_GUARDS: Array<Guard<AssignmentFacts["rework"], ReworkRefusal>> = [
  ({ row, revision }) => stale(row, revision),
  ({ row, open }) =>
    open === null
      ? null
      : { status: "cycle-open", assignmentId: row.id, cycleId: open.id, reason: open.reason },
  // One cycle answers one submitted result, so it starts from a result that is handed over.
  from(["awaiting-review"], (row) => ({
    status: "not-awaiting-review",
    assignmentId: row.id,
    state: row.state,
  })),
];

const INVALIDATE_GUARDS: Array<Guard<AssignmentFacts["invalidate"], InvalidateRefusal>> = [
  ({ row, revision }) => stale(row, revision),
  from(["accepted"], (row) => ({ status: "not-accepted", assignmentId: row.id, state: row.state })),
  // A review carries no result of its own. A review that read the work wrongly is answered by
  // reviewing that work again, so returning a review assignment to the frontier settles nothing.
  ({ row }) =>
    isReview(row.kind) ? { status: "review-not-invalidated", assignmentId: row.id } : null,
  // A merged commit is never invalidated: the defect becomes a new issue (decision 24).
  ({ row, merged }) =>
    merged === null ? null : { status: "merged", assignmentId: row.id, ...merged },
];

type Executable = Extract<AcceptFacts, { kind: "review" | "production" }>;
type AcceptGuard<F> = Guard<F, AcceptRefusal>;

/** The guards every acceptance by the crew passes first, in order. */
const ACCEPT_COMMON: Array<AcceptGuard<AcceptCommon>> = [
  ({ row, revision }) => stale(row, revision),
  // A reached limit is work that waits on the user. Accepting it here would settle by silence
  // what the crew already proved it could not settle by itself.
  ({ row, directions }) =>
    directions.length === 0
      ? null
      : { status: "direction-required", assignmentId: row.id, directions },
  // Work that read an invalidated result is paused, so accepting it would carry the defect on.
  ({ row, invalidated }) =>
    invalidated.length === 0
      ? null
      : { status: "input-invalidated", assignmentId: row.id, invalidated },
];

/**
 * Planning work is accepted with no attempt. Its record is checked in the same decision, so an
 * accepted decision always carries what it decided.
 */
const ACCEPT_PLANNING: Array<AcceptGuard<Extract<AcceptFacts, { kind: "planning" }>>> = [
  ({ row, attemptId }) =>
    attemptId === null ? null : { status: "attempt-not-expected", assignmentId: row.id },
  // An invalidated decision is answered by deciding again, and only that new acceptance
  // releases the dependents the invalidation paused.
  from(["registered", "invalidated"], notClaimed),
  // A decision taken before its own inputs are accepted is a decision on inputs that may still
  // change, so planning work waits on its dependencies as dispatched work does.
  ({ row, unmet }) =>
    unmet.length === 0
      ? null
      : { status: "dependency-pending", assignmentId: row.id, dependencies: unmet },
  // The record is what the planning work gives to the work that waits on it, so an acceptance
  // that records nothing would unblock a dependent that then receives nothing.
  ({ row, checked }) =>
    checked === null ? { status: "planning-record-required", assignmentId: row.id } : null,
  ({ checked }) => (checked === null || checked.status === "checked" ? null : checked),
];

/** The guards of executable work, before its kind splits it. */
const ACCEPT_EXECUTABLE: Array<AcceptGuard<Executable>> = [
  // Only planning work records a decision. Executable work hands over its result instead.
  ({ row, record }) =>
    record === null ? null : { status: "planning-record-not-expected", assignmentId: row.id },
  ({ row, attemptId }) =>
    attemptId === null ? { status: "attempt-required", assignmentId: row.id } : null,
  // Work that still waits on an answer is not finished work, so it is never accepted. This reads
  // ahead of every later gate, because an unanswered question is what the caller must settle
  // first and it holds the attempt before it can even hand over a result.
  ({ row, question }) =>
    question === null
      ? null
      : {
          status: "question-open",
          assignmentId: row.id,
          questionId: question.id,
          state: question.state,
        },
];

const ACCEPT_REVIEW: Array<AcceptGuard<Extract<AcceptFacts, { kind: "review" }>>> = [
  from(["claimed"], notClaimed),
  ({ row, live, attemptId }) =>
    live !== null && live.id === attemptId
      ? null
      : { status: "attempt-mismatch", assignmentId: row.id, attemptId: live?.id ?? null },
  // A review of a submission is complete when its own reports exist. It submits no result of its
  // own, so the review chain stops here instead of starting another review. Review work a source
  // registered by hand carries no submission, so it accepts like any other claimed assignment.
  ({ row, review }) =>
    review === null || review.state === "reported"
      ? null
      : {
          status: "review-incomplete",
          assignmentId: row.id,
          reviewId: review.id,
          state: review.state,
          blocker: review.blocker === null ? null : storedBlocker(review.blocker),
        },
];

type Produced = NonNullable<Extract<AcceptFacts, { kind: "production" }>["produced"]>;

/** Every recorded check must have passed. A flaky or unrun check proves nothing. */
function unprovenChecks(submission: SubmissionRow): Array<{ name: string; outcome: string }> {
  return storedChecks(submission.checks)
    .filter((check) => check.outcome !== "passed")
    .map((check) => ({ name: check.name, outcome: check.outcome }));
}

/**
 * Every check outcome a review observed that the producer did not record the same way.
 * A reviewer that ran a command for itself is independent evidence, so a producer that wrote
 * `passed` over a failing or flaky run cannot reach acceptance.
 */
function contradictedChecks(
  submission: SubmissionRow,
  reports: ReviewReportRow[],
): Array<{ name: string; axis: string; recorded: string; observed: string }> {
  const recorded = new Map(
    storedChecks(submission.checks).map((check) => [check.name, check.outcome]),
  );

  return reports.flatMap((report) =>
    storedObservedChecks(report.observedChecks).flatMap((observed) => {
      const producer = recorded.get(observed.name) ?? "not-recorded";
      return observed.outcome === "passed" && producer === "passed"
        ? []
        : [
            {
              name: observed.name,
              axis: report.axis,
              recorded: producer,
              observed: observed.outcome,
            },
          ];
    }),
  );
}

/** What the review of one submission owes, with its outside changes. */
function owedOf({ review, outside }: Produced) {
  return review === null
    ? null
    : Review.owed({ row: review.row, findings: review.findings, outside });
}

/**
 * The review gates of one code or non-code submission, in order. Every gate is a recorded fact,
 * so a process that exited, a missing input, an unavailable review capability, or a failed check
 * can never read as acceptance.
 */
const REVIEW_GATES: Array<AcceptGuard<Produced>> = [
  ({ submission, review, ...produced }) => {
    const owed = owedOf({ submission, review, ...produced });
    return owed === null || owed.owes === "report" || owed.owes === "replace"
      ? {
          status: "review-incomplete",
          assignmentId: submission.assignmentId,
          reviewId: review === null ? null : review.row.id,
          state: review === null ? "none" : review.row.state,
          blocker:
            review === null || review.row.blocker === null ? null : JSON.parse(review.row.blocker),
        }
      : null;
  },
  ({ submission, review }) => {
    const missing = review === null ? [] : missingAxes(review.reports);
    return review === null || missing.length === 0
      ? null
      : {
          status: "review-axes-incomplete",
          assignmentId: submission.assignmentId,
          reviewId: review.row.id,
          missing,
        };
  },
  (produced) => {
    const owed = owedOf(produced);
    return owed?.owes === "dispose" && produced.review !== null
      ? {
          status: "findings-undisposed",
          assignmentId: produced.submission.assignmentId,
          reviewId: produced.review.row.id,
          findingIds: owed.findings.map((one) => one.id),
        }
      : null;
  },
  // An accepted correction is delegated rework, so it blocks acceptance until that work lands.
  (produced) => {
    const owed = owedOf(produced);
    return owed?.owes === "rework" && produced.review !== null
      ? {
          status: "rework-pending",
          assignmentId: produced.submission.assignmentId,
          reviewId: produced.review.row.id,
          findingIds: owed.findings.map((one) => one.id),
        }
      : null;
  },
  ({ submission }) => {
    const unproven = unprovenChecks(submission);
    return unproven.length === 0
      ? null
      : { status: "checks-unproven", assignmentId: submission.assignmentId, checks: unproven };
  },
  // What a reviewer ran for itself outranks what the producer wrote about its own work.
  ({ submission, review }) => {
    const contradicted = review === null ? [] : contradictedChecks(submission, review.reports);
    return review === null || contradicted.length === 0
      ? null
      : {
          status: "checks-contradicted",
          assignmentId: submission.assignmentId,
          reviewId: review.row.id,
          checks: contradicted,
        };
  },
  // A recorded fact never passes by silence (ADR 0007), so each outside change is answered.
  (produced) => {
    const owed = owedOf(produced);
    return owed?.owes === "outside"
      ? {
          status: "outside-changes-undisposed",
          assignmentId: produced.submission.assignmentId,
          submissionId: produced.submission.id,
          changeIds: owed.changes.map((one) => one.id),
          security: owed.changes.filter((one) => one.security === 1).length,
        }
      : null;
  },
];

type ProductionFacts = Extract<AcceptFacts, { kind: "production" }>;

/** Production work reaches acceptance only through its own reviewed submission. */
const ACCEPT_PRODUCTION: Array<AcceptGuard<ProductionFacts>> = [
  // A claimed assignment that handed over nothing cannot be accepted.
  from(["awaiting-review"], notClaimed),
  ({ row, produced }) =>
    produced === null ? { status: "submission-required", assignmentId: row.id } : null,
  ({ row, produced, submissionId }) =>
    produced === null || submissionId === produced.submission.id
      ? null
      : {
          status: "submission-mismatch",
          assignmentId: row.id,
          recordedSubmissionId: produced.submission.id,
        },
  ({ row, produced, attemptId }) =>
    produced === null || produced.submission.attemptId === attemptId
      ? null
      : {
          status: "attempt-mismatch",
          assignmentId: row.id,
          attemptId: produced.submission.attemptId,
        },
  ({ produced }) => (produced === null ? null : firstRefusal(REVIEW_GATES, produced)),
];

function firstRefusal<F, R>(guards: ReadonlyArray<Guard<F, R>>, facts: F): R | null {
  for (const guard of guards) {
    const refused = guard(facts);
    if (refused !== null) {
      return refused;
    }
  }
  return null;
}

/** The acceptance rows of each kind of work, after the guards they share. */
function acceptRefusal(facts: AcceptFacts): AcceptRefusal | null {
  switch (facts.kind) {
    case "planning":
      return firstRefusal([...ACCEPT_COMMON, ...ACCEPT_PLANNING], facts);
    case "review":
      return firstRefusal([...ACCEPT_COMMON, ...ACCEPT_EXECUTABLE, ...ACCEPT_REVIEW], facts);
    case "production":
      return firstRefusal([...ACCEPT_COMMON, ...ACCEPT_EXECUTABLE, ...ACCEPT_PRODUCTION], facts);
    // A merged result is taken back with no correction, only from its invalidation.
    case "merged":
      return from(["invalidated"], notClaimed)(facts);
  }
}

/**
 * The state one paused dependent returns to. Work that was accepted returns to the step that
 * decided it, because an acceptance that read an invalid input is a decision to take again, not
 * a state to carry over. A merged commit changes no input, so its dependents return as they were.
 */
function resumedState({ consumed, cause, submitted }: AssignmentFacts["resume"]): AssignmentState {
  if (cause === "merged" || consumed !== "accepted") {
    return consumed;
  }
  return submitted ? "awaiting-review" : "registered";
}

type Entry<E extends AssignmentEvent> = {
  refusal: (facts: AssignmentFacts[E]) => AssignmentRefusal[E] | null;
  next: (facts: AssignmentFacts[E]) => AssignmentNext[E];
};

function to(state: AssignmentState, closes: CorrectionClose = {}) {
  return () => ({ state, closes });
}

/** The transition table of an assignment: the guards of each event in order, and the next state. */
const ASSIGNMENT_TABLE: { [E in AssignmentEvent]: Entry<E> } = {
  claim: { refusal: (facts) => firstRefusal(CLAIM_GUARDS, facts), next: to("claimed") },
  // Only a claimed production assignment hands a result over.
  submit: { refusal: from(["claimed"], notClaimed), next: to("awaiting-review") },
  rework: { refusal: (facts) => firstRefusal(REWORK_GUARDS, facts), next: to("rework") },
  invalidate: {
    refusal: (facts) => firstRefusal(INVALIDATE_GUARDS, facts),
    next: to("invalidated"),
  },
  // A pause is this workflow's own mark, so work an earlier defect paused stays as it is.
  pause: {
    refusal: ({ row }) => (row.state === "paused" ? unmoved(row) : null),
    next: to("paused"),
  },
  // Work that also read another invalid result keeps waiting for that correction.
  resume: {
    refusal: ({ row, held }) => (row.state !== "paused" || held ? unmoved(row) : null),
    next: (facts) => ({ state: resumedState(facts), closes: {} }),
  },
  // An acceptance by the crew releases what an earlier defect on this work paused, and a merged
  // acceptance closes that defect and its cycle with no correction.
  accept: {
    refusal: acceptRefusal,
    next: ({ kind }) =>
      kind === "merged"
        ? { state: "accepted", closes: { invalidation: "merged", cycle: "merged" } }
        : { state: "accepted", closes: { invalidation: "resolved" } },
  },
  // A withdrawal closes every open correction of the work. An item moves from any state the
  // plan withdraws it from. A holder that already finished or closed stays as it is.
  withdraw: {
    refusal: ({ row, as }) =>
      as === "holder" && (row.state === "accepted" || row.state === "withdrawn")
        ? unmoved(row)
        : null,
    next: to("withdrawn", {
      cycle: "withdrawn",
      invalidation: "withdrawn",
      direction: "withdrawn",
    }),
  },
  // A rewrite that took out a landed commit returns its acceptance to be taken again.
  reopen: { refusal: from(["accepted"], unmoved), next: to("awaiting-review") },
};

/** Where the frontier files one assignment before it reads any dispatch rule. */
export type Placement = "accepted" | "withdrawn" | "planning" | "active" | "open";

/** What the frontier reads to decide whether one open assignment may start now. */
export type BlockerFacts = {
  row: { state: string; kind: string };
  /** The open direction requests no approval of the user answers yet. */
  undirected: Array<{ id: string; limitKind: LimitKind }>;
  /** The review assignment of the latest submission. */
  reviewAssignmentId: string | null;
  /** The commits of withdrawn work the integration branch of the source still holds. */
  takeOut: Array<{ assignmentId: string; commit: string }>;
  unmet: Dependency[];
  /** The holders of overlapping write paths, or null for work that keeps the base it started on. */
  holders: { holders: WritePathHolder[]; command: string } | null;
  capacity: { limit: number; productionLimit: number; openSlots: number; heldProduction: number };
};

/** The dispatch rules of one open assignment, in order. The first blocker withholds it. */
const BLOCKER_ROWS: ReadonlyArray<Guard<BlockerFacts, FrontierBlocker[]>> = [
  // A reached limit waits on the user, whatever state the assignment stopped in. A direction the
  // user already gave waits on nobody, and the action it permits spends it.
  ({ undirected }) =>
    undirected.length === 0
      ? null
      : undirected.map((request) => ({
          reason: "direction_required" as const,
          directionRequestId: request.id,
          limitKind: request.limitKind,
        })),
  // A submitted result waits for its own review, not for a second attempt at the same work.
  ({ row, reviewAssignmentId }) =>
    row.state === "awaiting-review" ? [{ reason: "review_pending", reviewAssignmentId }] : null,
  ({ row, takeOut }) =>
    row.kind === "production" && takeOut.length > 0
      ? [{ reason: "take_out_pending", commits: takeOut }]
      : null,
  ({ unmet }) =>
    unmet.length === 0 ? null : [{ reason: "dependency_pending", dependencies: unmet }],
  // Work that has started keeps the base of its dispatch, so only new work waits for a holder.
  // An entry held here takes no slot, so the next entry in priority order can still start.
  ({ holders }) =>
    holders === null || holders.holders.length === 0
      ? null
      : [{ reason: "write_paths_overlap", holders: holders.holders, command: holders.command }],
  ({ capacity }) =>
    capacity.openSlots === 0 ? [{ reason: "crew_at_capacity", limit: capacity.limit }] : null,
  ({ row, capacity }) =>
    !isReview(row.kind) && capacity.heldProduction >= capacity.productionLimit
      ? [{ reason: "review_capacity_reserved", productionLimit: capacity.productionLimit }]
      : null,
];

export const Assignment = {
  /**
   * Decides one event on one assignment. It is pure: it reads only the facts the caller
   * gathered, and it returns the first refusal in the order of the table, or the next state with
   * the correction records the move closes.
   */
  decide<E extends AssignmentEvent>(
    event: E,
    facts: AssignmentFacts[E],
  ): { refused: AssignmentRefusal[E] } | { next: AssignmentNext[E] } {
    const entry: Entry<E> = ASSIGNMENT_TABLE[event];
    const refused = entry.refusal(facts);
    return refused === null ? { next: entry.next(facts) } : { refused };
  },

  /**
   * Where the frontier files one assignment. Accepted and withdrawn work is settled, work that
   * read an invalidated result waits for the corrected one whatever kind it is and whatever its
   * former writer is still doing, planning work is decided by the Operator, and work with a live
   * attempt is already running.
   */
  place(facts: {
    row: { state: string; kind: string };
    invalidated: string[] | undefined;
    active: boolean;
  }): Placement | FrontierBlocker[] {
    const { row, invalidated } = facts;
    if (row.state === "accepted" || row.state === "withdrawn") {
      return row.state;
    }
    if (invalidated !== undefined) {
      return [{ reason: "input_invalidated", invalidated }];
    }
    if (!isExecutable(row.kind)) {
      return "planning";
    }
    return facts.active ? "active" : "open";
  },

  /** The blockers that withhold one open assignment from dispatch, or null when it may start. */
  blockerOf(facts: BlockerFacts): FrontierBlocker[] | null {
    return firstRefusal(BLOCKER_ROWS, facts);
  },
};
