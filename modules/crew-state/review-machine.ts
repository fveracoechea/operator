import { PullRequestStack } from "../pull-request-stack/main.ts";
import type { BranchSnapshotRow, SnapshotCommit } from "./branch-review.ts";
import { type OutsideChangeRow, undisposedOutside } from "./outside-changes.ts";
import {
  type AxisReport,
  type BranchReportInput,
  type DispositionInput,
  type FindingDisposition,
  type ReviewReportInput,
  storedTargets,
  type SubAgentRecord,
} from "./review-input.ts";
import {
  corrections,
  REVIEW_AXES,
  type ReviewFindingRow,
  type ReviewRow,
  undisposed,
} from "./review.ts";
import { requiredCoverage, storedBehaviorChanges, storedResultKind } from "./submission-input.ts";
import type { SubmissionRow } from "./submission.ts";

/**
 * The review machine (ADR 0023, ADR 0007). One `reviews` row moves through `ReviewState`.
 * A report or a blocker ends a registered review, the Operator answers the findings of a
 * reported one, a replacement reopens an unfinished one, and a withdrawal closes it.
 * The findings and the outside changes keep their own `disposition`.
 */
export type ReviewEvent = "report" | "block" | "dispose" | "withdraw" | "reopen";

/** The coverage a branch review states. It reads the whole range and names no behavior changes. */
export function branchCoverage(): string[] {
  return requiredCoverage("code", false);
}

/** The fixed subject one report names: a submission, or a branch snapshot. */
export type ReportSubject =
  | {
      kind: "submission";
      submission: SubmissionRow;
      input: ReviewReportInput;
      // True for the only code result of its source, which publishes with no branch review.
      publishes: boolean;
    }
  | {
      kind: "branch";
      snapshot: BranchSnapshotRow;
      commits: SnapshotCommit[];
      input: BranchReportInput;
    };

type ReportedInput = Extract<ReviewReportInput | BranchReportInput, { kind: "reported" }>;

/** The refusals of a report or a blocker, in the order the table checks them. */
export type ReportRefusal =
  | { status: "review-settled"; reviewId: string; state: string }
  | { status: "submission-drift"; reviewId: string; recorded: string; stated: string }
  | { status: "snapshot-drift"; reviewId: string; recorded: string; stated: string }
  | { status: "host-mismatch"; reviewId: string; recorded: string; stated: string }
  | { status: "axes-incomplete"; reviewId: string; missing: string[] }
  | { status: "sub-agent-host-mismatch"; reviewId: string; recorded: string; stated: string[] }
  | { status: "sub-agent-failed"; reviewId: string; axes: string[] }
  | {
      status: "axes-not-parallel";
      reviewId: string;
      windows: Array<{ axis: string; startedAt: string; endedAt: string }>;
    }
  | {
      status: "coverage-incomplete";
      reviewId: string;
      gaps: Array<{ axis: string; missing: string[] }>;
    }
  | {
      status: "finding-untargeted";
      reviewId: string;
      findings: Array<{ axis: string; key: string }>;
    }
  | {
      status: "finding-target-unknown";
      reviewId: string;
      findings: Array<{ axis: string; key: string; targets: string[] }>;
    }
  | { status: "cut-not-between-commits"; reviewId: string; cuts: string[]; detail: string }
  | { status: "published-text-missing"; reviewId: string };

/** The refusals of a disposition, in the order the table checks them. */
export type DisposeRefusal =
  | { status: "review-not-reported"; reviewId: string; state: string }
  | { status: "unknown-finding"; reviewId: string; findingIds: string[] }
  | { status: "blocker-not-deferrable"; reviewId: string; findingIds: string[] }
  | { status: "correction-target-not-expected"; reviewId: string; findingIds: string[] }
  | { status: "correction-target-required"; reviewId: string; findingIds: string[] }
  | {
      status: "correction-target-unknown";
      reviewId: string;
      findings: Array<{ findingId: string; target: string; allowed: string[] }>;
    };

type Reported = { status: "review-reported"; reviewId: string };

/**
 * What each event reads before it decides. The caller gathers these facts. An event on a review
 * that is not recorded is refused by the read that finds no row, before any guard.
 */
export type ReviewFacts = {
  /** The host the review launch recorded. */
  report: { row: ReviewRow; subject: ReportSubject; agentHost: string };
  block: { row: ReviewRow; subject: ReportSubject; agentHost: string };
  /** The commits of the branch snapshot, or null for a result review. */
  dispose: {
    row: ReviewRow;
    held: Map<string, ReviewFindingRow>;
    input: DispositionInput;
    commits: SnapshotCommit[] | null;
  };
  withdraw: { row: ReviewRow };
  reopen: { row: ReviewRow };
};

/** The refusals of each event. */
export type ReviewRefusal = {
  report: ReportRefusal;
  block: ReportRefusal;
  dispose: DisposeRefusal;
  withdraw: Reported;
  reopen: Reported;
};

/**
 * The state each event moves a review to. A disposition leaves it reported and names the one
 * target assignment of each corrected branch finding, which the interpreter invalidates.
 */
export type ReviewNext = {
  report: "reported";
  block: "blocked";
  dispose: { state: "reported"; targets: Map<string, string> };
  withdraw: "withdrawn";
  reopen: "registered";
};

type Guard<F, R> = (facts: F) => R | null;
type ReportGuard = Guard<ReviewFacts["report"], ReportRefusal>;
type DisposeGuard = Guard<ReviewFacts["dispose"], DisposeRefusal>;

/** The required axes one list does not state exactly once, which is what makes it incomplete. */
function axesNotStatedOnce(entries: Array<{ axis: string }>): string[] {
  return REVIEW_AXES.filter((axis) => entries.filter((one) => one.axis === axis).length !== 1);
}

/**
 * True when both sub-agent windows overlap.
 * The skill requires the two axes to run in parallel and in separate contexts, so a pair that
 * ran one after the other is a different review than the one that was approved.
 */
function ranInParallel(subAgents: SubAgentRecord[]): boolean {
  const latestStart = subAgents
    .map((one) => Date.parse(one.startedAt))
    .reduce((highest, value) => Math.max(highest, value), Number.NEGATIVE_INFINITY);
  const earliestEnd = subAgents
    .map((one) => Date.parse(one.endedAt))
    .reduce((lowest, value) => Math.min(lowest, value), Number.POSITIVE_INFINITY);
  return latestStart < earliestEnd;
}

function coverageGaps(
  reports: Array<Pick<AxisReport, "axis" | "checked">>,
  required: string[],
): Array<{ axis: string; missing: string[] }> {
  return reports.flatMap((report) => {
    const missing = required.filter((token) => !report.checked.includes(token));
    return missing.length === 0 ? [] : [{ axis: report.axis, missing }];
  });
}

/** The coverage each axis of this subject must state. */
function coverageOf(subject: ReportSubject): string[] {
  return subject.kind === "branch"
    ? branchCoverage()
    : requiredCoverage(
        storedResultKind(subject.submission.resultKind),
        storedBehaviorChanges(subject.submission.behaviorChanges) !== null,
      );
}

/** A guard on the content of a report. A blocker carries no content, so it passes. */
function onContent(
  guard: (facts: ReviewFacts["report"], input: ReportedInput) => ReportRefusal | null,
): ReportGuard {
  return (facts) =>
    facts.subject.input.kind === "reported" ? guard(facts, facts.subject.input) : null;
}

/** A guard of a branch report only, on the findings and the cuts it names. */
function onBranch(
  guard: (
    reviewId: string,
    subject: Extract<ReportSubject, { kind: "branch" }>,
    input: Extract<BranchReportInput, { kind: "reported" }>,
  ) => ReportRefusal | null,
): ReportGuard {
  return ({ row, subject }) =>
    subject.kind === "branch" && subject.input.kind === "reported"
      ? guard(row.id, subject, subject.input)
      : null;
}

/** The findings of a branch report, each with the commits it targets. */
function branchFindings(input: Extract<BranchReportInput, { kind: "reported" }>) {
  return input.reports.flatMap((report) =>
    report.findings.map((one) => ({ axis: report.axis, key: one.key, targets: one.targets })),
  );
}

/** The guards both a report and a blocker pass, in order. */
const SUBJECT_GUARDS: ReportGuard[] = [
  ({ row }) =>
    row.state === "registered"
      ? null
      : { status: "review-settled", reviewId: row.id, state: row.state },
  // The report names the exact submission it read, so a moved result cannot pass as reviewed.
  ({ row, subject }) =>
    subject.kind !== "submission" ||
    subject.input.submissionIdentity === subject.submission.identity
      ? null
      : {
          status: "submission-drift",
          reviewId: row.id,
          recorded: subject.submission.identity,
          stated: subject.input.submissionIdentity,
        },
  // The report names the exact snapshot it read, so a review of another head or another commit
  // list cannot pass as the review of this one (ADR 0017).
  ({ row, subject }) =>
    subject.kind !== "branch" || subject.input.snapshotIdentity === subject.snapshot.identity
      ? null
      : {
          status: "snapshot-drift",
          reviewId: row.id,
          recorded: subject.snapshot.identity,
          stated: subject.input.snapshotIdentity,
        },
  // The stated host is what `review show` reports, so it must be the host the launch recorded.
  ({ row, subject, agentHost }) =>
    subject.input.host === agentHost
      ? null
      : {
          status: "host-mismatch",
          reviewId: row.id,
          recorded: agentHost,
          stated: subject.input.host,
        },
];

/** The guards on the content of a report, in order, after the subject guards. */
const CONTENT_GUARDS: ReportGuard[] = [
  onContent(({ row }, input) => {
    const missing = [
      ...new Set([...axesNotStatedOnce(input.reports), ...axesNotStatedOnce(input.subAgents)]),
    ];
    return missing.length === 0 ? null : { status: "axes-incomplete", reviewId: row.id, missing };
  }),
  // The sub-agents are native to the reviewer host, so they hold no Herdr slot of their own.
  onContent(({ row, agentHost }, input) => {
    const foreign = [...new Set(input.subAgents.map((one) => one.host))].filter(
      (host) => host !== agentHost,
    );
    return foreign.length === 0
      ? null
      : {
          status: "sub-agent-host-mismatch",
          reviewId: row.id,
          recorded: agentHost,
          stated: foreign,
        };
  }),
  onContent(({ row }, input) => {
    const failed = input.subAgents
      .filter((one) => one.status !== "completed")
      .map((one) => one.axis);
    return failed.length === 0
      ? null
      : { status: "sub-agent-failed", reviewId: row.id, axes: failed };
  }),
  onContent(({ row }, input) =>
    ranInParallel(input.subAgents)
      ? null
      : {
          status: "axes-not-parallel",
          reviewId: row.id,
          windows: input.subAgents.map((one) => ({
            axis: one.axis,
            startedAt: one.startedAt,
            endedAt: one.endedAt,
          })),
        },
  ),
  onContent(({ row, subject }, input) => {
    const gaps = coverageGaps(input.reports, coverageOf(subject));
    return gaps.length === 0 ? null : { status: "coverage-incomplete", reviewId: row.id, gaps };
  }),
  // A branch finding is corrected by invalidating the assignment of one target commit, so a
  // finding with no target, or with a commit outside the snapshot, could never be answered.
  onBranch((reviewId, _subject, input) => {
    const untargeted = branchFindings(input).filter((one) => one.targets.length === 0);
    return untargeted.length === 0
      ? null
      : {
          status: "finding-untargeted",
          reviewId,
          findings: untargeted.map((one) => ({ axis: one.axis, key: one.key })),
        };
  }),
  onBranch((reviewId, subject, input) => {
    const held = new Set(subject.commits.map((one) => one.commit));
    const unknown = branchFindings(input)
      .map((one) => ({ ...one, targets: one.targets.filter((target) => !held.has(target)) }))
      .filter((one) => one.targets.length > 0);
    return unknown.length === 0
      ? null
      : { status: "finding-target-unknown", reviewId, findings: unknown };
  }),
  // The plan refuses the same cuts, so the reviewer learns it now, not after the review counts.
  onBranch((reviewId, subject, input) => {
    const refused = PullRequestStack.cutRefusal({
      commits: subject.commits.map((one) => one.commit),
      cuts: input.published.cuts,
    });
    return refused === null
      ? null
      : { status: "cut-not-between-commits", reviewId, cuts: refused.cuts, detail: refused.detail };
  }),
  // The reviewer of what publishes writes its pull request text, so the Operator writes none.
  onContent(({ row, subject }, input) =>
    subject.kind === "submission" && subject.publishes && (input.published ?? null) === null
      ? { status: "published-text-missing", reviewId: row.id }
      : null,
  ),
];

/** The corrected dispositions of one answer. */
function corrected(input: DispositionInput) {
  return input.dispositions.filter(
    (one): one is Extract<FindingDisposition, { disposition: "corrected" }> =>
      one.disposition === "corrected",
  );
}

/**
 * The guards of a disposition, in order. Every finding is answered: corrected, rejected with a
 * reason and the evidence that refutes it, or deferred with a reason and a follow-up reference.
 */
const DISPOSE_GUARDS: DisposeGuard[] = [
  ({ row }) =>
    row.state === "reported"
      ? null
      : { status: "review-not-reported", reviewId: row.id, state: row.state },
  ({ row, held, input }) => {
    const unknown = input.dispositions.map((one) => one.findingId).filter((id) => !held.has(id));
    return unknown.length === 0
      ? null
      : { status: "unknown-finding", reviewId: row.id, findingIds: unknown };
  },
  // An improvement may wait. A blocker is either corrected or rejected with a stated reason,
  // because deferring one would waive an approved requirement through judgment alone.
  ({ row, held, input }) => {
    const deferred = input.dispositions
      .filter(
        (one) => one.disposition === "deferred" && held.get(one.findingId)?.severity === "blocker",
      )
      .map((one) => one.findingId);
    return deferred.length === 0
      ? null
      : { status: "blocker-not-deferrable", reviewId: row.id, findingIds: deferred };
  },
  // A finding of a result review targets its own submission, so it names no target.
  ({ row, input, commits }) => {
    const named = corrected(input)
      .filter((one) => one.target !== undefined)
      .map((one) => one.findingId);
    return commits !== null || named.length === 0
      ? null
      : { status: "correction-target-not-expected", reviewId: row.id, findingIds: named };
  },
  ({ row, input, commits }) => {
    const missing = corrected(input)
      .filter((one) => one.target === undefined)
      .map((one) => one.findingId);
    return commits === null || missing.length === 0
      ? null
      : { status: "correction-target-required", reviewId: row.id, findingIds: missing };
  },
  // The target must hold one of the commits the finding targets, because a correction
  // invalidates exactly that accepted result (ADR 0017).
  ({ row, held, input, commits }) => {
    if (commits === null) {
      return null;
    }
    const unknown = corrected(input).flatMap((one) => {
      const finding = held.get(one.findingId);
      const aimed = finding?.targets == null ? [] : storedTargets(finding.targets);
      const allowed = [
        ...new Set(
          commits
            .filter((commit) => aimed.includes(commit.commit))
            .map((commit) => commit.assignmentId),
        ),
      ];
      const target = one.target ?? "";
      return allowed.includes(target) ? [] : [{ findingId: one.findingId, target, allowed }];
    });
    return unknown.length === 0
      ? null
      : { status: "correction-target-unknown", reviewId: row.id, findings: unknown };
  },
];

/** A reported review is finished. It is never reopened or withdrawn. */
const unfinished: Guard<{ row: ReviewRow }, Reported> = ({ row }) =>
  row.state === "reported" ? { status: "review-reported", reviewId: row.id } : null;

type Entry<E extends ReviewEvent> = {
  guards: Array<Guard<ReviewFacts[E], ReviewRefusal[E]>>;
  next: (facts: ReviewFacts[E]) => ReviewNext[E];
};

/** The transition table of a review: the guards of each event in order, and the next state. */
const REVIEW_TABLE: { [E in ReviewEvent]: Entry<E> } = {
  report: { guards: [...SUBJECT_GUARDS, ...CONTENT_GUARDS], next: () => "reported" },
  // A blocker is a stopped review, not a verdict, so it carries no content to check.
  block: { guards: SUBJECT_GUARDS, next: () => "blocked" },
  dispose: {
    guards: DISPOSE_GUARDS,
    next: ({ input, commits }) => ({
      state: "reported",
      targets:
        commits === null
          ? new Map()
          : new Map(corrected(input).map((one) => [one.findingId, one.target ?? ""])),
    }),
  },
  // A withdrawn review is withdrawn again, so a repeated withdrawal records it again.
  withdraw: { guards: [unfinished], next: () => "withdrawn" },
  // A blocked review is a stopped review, so a replacement attempt may report it.
  reopen: { guards: [unfinished], next: () => "registered" },
};

/** What one review owes next. The reader of the coordination order acts on it. */
export type ReviewOwed =
  | { owes: "report" }
  | { owes: "replace" }
  | { owes: "dispose"; findings: ReviewFindingRow[] }
  | { owes: "rework"; findings: ReviewFindingRow[] }
  | { owes: "outside"; changes: OutsideChangeRow[] }
  | { owes: "nothing" };

export const Review = {
  /**
   * Decides one event on one review. It is pure: it reads only the facts the caller gathered,
   * and it returns the first refusal in the order of the table, or the next state.
   */
  decide<E extends ReviewEvent>(
    event: E,
    facts: ReviewFacts[E],
  ): { refused: ReviewRefusal[E] } | { next: ReviewNext[E] } {
    const entry: Entry<E> = REVIEW_TABLE[event];
    for (const guard of entry.guards) {
      const refused = guard(facts);
      if (refused !== null) {
        return { refused };
      }
    }
    return { next: entry.next(facts) };
  },

  /**
   * The one step a review owes, read from its state and the dispositions of its findings and
   * outside changes. A blocked review owes a replacement, an unfinished one owes its report, and
   * a reported one owes every answer before an accepted correction or an outside change.
   */
  owed(facts: {
    row: ReviewRow;
    findings: ReviewFindingRow[];
    outside: OutsideChangeRow[];
  }): ReviewOwed {
    if (facts.row.state === "blocked") {
      return { owes: "replace" };
    }
    if (facts.row.state !== "reported") {
      return { owes: "report" };
    }
    const open = undisposed(facts.findings);
    if (open.length > 0) {
      return { owes: "dispose", findings: open };
    }
    const pending = corrections(facts.findings);
    if (pending.length > 0) {
      return { owes: "rework", findings: pending };
    }
    const outside = undisposedOutside(facts.outside);
    return outside.length > 0 ? { owes: "outside", changes: outside } : { owes: "nothing" };
  },
};
