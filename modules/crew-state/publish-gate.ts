import { and, eq, inArray } from "drizzle-orm";
import { ProjectGate } from "../project-gate/main.ts";
import { readAssignment } from "./assignment.ts";
import { branchCondition, branchReviewsOf, type SnapshotCommit } from "./branch-review.ts";
import type { CrewReader } from "./database.ts";
import {
  baseGateOf,
  commandsOfRun,
  declaredCommands,
  type GateRunRow,
  keyStatus,
} from "./gate-runs.ts";
import { fixedGateOf, integrationBranchOf, sourceSlug } from "./integration.ts";
import { storedObservedChecks, storedPublishedText, storedTargets } from "./review-input.ts";
import { findingsOf, reportsOf, reviewOfSubmission, type ReviewRow } from "./review.ts";
import { assignments, directionRequests, gateRuns, workSources } from "./schema.ts";
import { storedBehaviorChanges, storedConcerns } from "./submission-input.ts";
import { readSubmission } from "./submission.ts";
import { storedRequirements, storedTrackerBinding, storedTrackerLocation } from "./work-input.ts";

/**
 * The refusals of a publish plan that the crew records decide, in the fixed order of decision 10
 * of the publish: the branch review gate (ADR 0017), the gate records (ADR 0021), an open
 * invalidation, withdrawal, or direction request, and nothing to publish. They are members of the
 * durable unions of ADR 0011.
 */
export type RecordRefusal = {
  reason:
    | "branch_review_missing"
    | "review_findings_undisposed"
    | "review_correction_pending"
    | "branch_review_checks_missing"
    | "branch_review_checks_differ"
    | "gate_base_not_passed"
    | "gate_commit_not_passed"
    | "invalidation_open"
    | "withdrawal_open"
    | "direction_open"
    | "nothing_to_publish";
  detail: string;
};

/** One commit of the head with the records its pull request body renders. */
export type GatedCommit = SnapshotCommit & {
  closes: string | null;
  behaviorChanges: Array<{
    statement: string;
    basis:
      | { kind: "approved-scope" }
      | { kind: "requirement"; position: number; text: string | null }
      | { kind: "question"; questionId: string };
  }>;
  concerns: string[];
};

/** What a publish plan of one source reads from the crew state. It reads no Git and no GitHub. */
export type PublishRecords = {
  sourceId: string;
  repository: string | null;
  slug: string;
  base: string | null;
  head: string | null;
  commits: GatedCommit[];
  /** The review whose report gates the publish and wrote its text. */
  gatingReview: ReviewRow | null;
  text: ReturnType<typeof storedPublishedText> | null;
  verified: {
    gateCommands: string[];
    gateRuns: Array<{ runId: string; commit: string; at: "base" | "commit" }>;
    reviews: Array<{ kind: "result" | "branch"; reviewId: string; subject: string; host: string }>;
  };
  rejected: Array<{ summary: string; reason: string; evidence: string; targets: string[] }>;
  deferred: Array<{ summary: string; reason: string; followUp: string }>;
  refusals: RecordRefusal[];
};

/** The passing run at the key of one commit, from the latest run that names the commit. */
function passingRunAt(db: CrewReader, sourceId: string, commit: string): GateRunRow | null {
  const latest = db
    .select()
    .from(gateRuns)
    .where(and(eq(gateRuns.sourceId, sourceId), eq(gateRuns.commit, commit)))
    .all()
    .toSorted((left, right) => left.startedAt.localeCompare(right.startedAt))
    .at(-1);
  if (latest === undefined) {
    return null;
  }
  const verdict = keyStatus(db, {
    tree: latest.tree,
    declarationIdentity: latest.declarationIdentity,
  });
  return verdict.status === "passed" ? (verdict.passed.at(-1) ?? null) : null;
}

/** The records of one commit that its pull request body renders. */
function gatedCommit(db: CrewReader, commit: SnapshotCommit): GatedCommit {
  const holder = readAssignment(db, commit.assignmentId);
  const submission = readSubmission(db, commit.submissionId);
  const requirements = holder === null ? [] : storedRequirements(holder.acceptanceRequirements);
  const binding =
    holder?.trackerBinding == null ? null : storedTrackerBinding(holder.trackerBinding);
  return {
    ...commit,
    closes: binding === null ? null : `${binding.repository}#${binding.issue}`,
    behaviorChanges: (storedBehaviorChanges(submission?.behaviorChanges ?? null) ?? []).map(
      (change) => ({
        statement: change.statement,
        basis:
          change.basis.kind === "requirement"
            ? { ...change.basis, text: requirements[change.basis.position - 1] ?? null }
            : change.basis,
      }),
    ),
    concerns: submission === null ? [] : storedConcerns(submission.concerns),
  };
}

/**
 * The branch review gate on its observed checks: every project gate command has an observation
 * at the head, and each one equals the outcome the gate run at the head key recorded.
 */
function checkRefusals(
  db: CrewReader,
  review: ReviewRow,
  headRun: GateRunRow | null,
): RecordRefusal[] {
  if (headRun === null) {
    return [];
  }
  const observed = reportsOf(db, review.id).flatMap((report) =>
    storedObservedChecks(report.observedChecks),
  );
  const refusals: RecordRefusal[] = [];
  const declared = new Map(commandsOfRun(db, headRun.id).map((one) => [one.position, one.outcome]));
  const commands = declaredCommands(headRun).map((one) => ProjectGate.commandLine(one.argv));
  commands.forEach((line, position) => {
    const seen = observed.filter((one) => one.name === line);
    const recorded = declared.get(position) ?? null;
    if (seen.length === 0) {
      refusals.push({
        reason: "branch_review_checks_missing",
        detail: `Branch review ${review.id} observed no run of the gate command \`${line}\` at the head.`,
      });
    } else if (seen.some((one) => one.outcome !== recorded)) {
      refusals.push({
        reason: "branch_review_checks_differ",
        detail: `Branch review ${review.id} observed \`${line}\` as ${seen.map((one) => one.outcome).join(", ")}, and gate run ${headRun.id} at the head recorded ${recorded ?? "no outcome"}.`,
      });
    }
  });
  return refusals;
}

/** The review gate of decision 10: one review reported on the exact head, fully answered. */
function reviewRefusals(
  db: CrewReader,
  review: ReviewRow | null,
  branch: boolean,
  headRun: GateRunRow | null,
): RecordRefusal[] {
  if (review === null || review.state !== "reported") {
    return [
      {
        reason: "branch_review_missing",
        detail: branch
          ? "No branch review reported on the exact head of the integration branch."
          : "The result review of the one commit has not reported.",
      },
    ];
  }
  const findings = findingsOf(db, review.id);
  const open = findings.filter((one) => one.disposition === null);
  const corrected = findings.filter((one) => one.disposition === "corrected");
  return [
    ...(open.length === 0
      ? []
      : [
          {
            reason: "review_findings_undisposed" as const,
            detail: `Review ${review.id} holds ${open.length} finding(s) with no disposition: ${open.map((one) => one.id).join(", ")}.`,
          },
        ]),
    ...(corrected.length === 0 || !branch
      ? []
      : [
          {
            reason: "review_correction_pending" as const,
            detail: `Review ${review.id} holds ${corrected.length} corrected finding(s), so the head changes before it publishes.`,
          },
        ]),
    ...(branch ? checkRefusals(db, review, headRun) : []),
  ];
}

/** The open invalidation, withdrawal, and direction request of one source, in that order. */
function openRefusals(
  db: CrewReader,
  sourceId: string,
  condition: ReturnType<typeof branchCondition>,
): RecordRefusal[] {
  const held = db.select().from(assignments).where(eq(assignments.sourceId, sourceId)).all();
  const invalidated = held.filter((row) => row.state === "invalidated" || row.state === "paused");
  const directions =
    held.length === 0
      ? []
      : db
          .select()
          .from(directionRequests)
          .where(
            and(
              inArray(
                directionRequests.assignmentId,
                held.map((row) => row.id),
              ),
              eq(directionRequests.state, "open"),
            ),
          )
          .all();
  return [
    ...(invalidated.length === 0
      ? []
      : [
          {
            reason: "invalidation_open" as const,
            detail: `These assignments wait on an invalidation cycle: ${invalidated.map((row) => `${row.id} (${row.state})`).join(", ")}.`,
          },
        ]),
    ...(condition.status !== "take-out-pending"
      ? []
      : [
          {
            reason: "withdrawal_open" as const,
            detail: `The branch still holds the commit of each withdrawn assignment: ${condition.assignmentIds.join(", ")}.`,
          },
        ]),
    ...(directions.length === 0
      ? []
      : [
          {
            reason: "direction_open" as const,
            detail: `These direction requests wait on the person: ${directions.map((one) => one.id).join(", ")}.`,
          },
        ]),
  ];
}

/**
 * The review whose report gates the publish and wrote its text: the branch review reported on
 * the exact snapshot of the head, or the result review of the one commit of a source with no
 * branch review (ADR 0017).
 */
function gatingReviewOf(
  db: CrewReader,
  sourceId: string,
  condition: ReturnType<typeof branchCondition>,
): ReviewRow | null {
  if (condition.status === "due") {
    return (
      branchReviewsOf(db, sourceId)
        .filter((one) => one.snapshot.identity === condition.identity)
        .map((one) => one.review)
        .filter((review) => review.state === "reported")
        .at(-1) ?? null
    );
  }
  const [only] = condition.status === "one-commit" ? condition.commits : [];
  return only === undefined ? null : reviewOfSubmission(db, only.submissionId);
}

/**
 * The rejected and the deferred findings of every review that read a commit of this head, with
 * the answer each received. A result finding targets its own commit.
 */
function answeredFindings(
  db: CrewReader,
  resultReviews: Array<{ review: ReviewRow; commit: string }>,
  branchReview: ReviewRow | null,
): Pick<PublishRecords, "rejected" | "deferred"> {
  const answered = [
    ...resultReviews.map((one) => ({ review: one.review, targets: [one.commit] })),
    ...(branchReview === null ? [] : [{ review: branchReview, targets: null }]),
  ].flatMap((one) =>
    findingsOf(db, one.review.id).map((finding) => ({
      finding,
      targets: one.targets ?? (finding.targets === null ? [] : storedTargets(finding.targets)),
    })),
  );
  return {
    rejected: answered
      .filter((one) => one.finding.disposition === "rejected")
      .map((one) => ({
        summary: one.finding.summary,
        reason: one.finding.reason ?? "",
        evidence: one.finding.dispositionEvidence ?? "",
        targets: one.targets,
      })),
    deferred: answered
      .filter((one) => one.finding.disposition === "deferred")
      .map((one) => ({
        summary: one.finding.summary,
        reason: one.finding.reason ?? "",
        followUp: one.finding.followUp ?? "",
      })),
  };
}

/**
 * Reads everything a publish plan of one source takes from the crew state: the head, its
 * commits with their records, the review that gates it and its text, the evidence, and every
 * refusal the records decide (decision 10). `crew next` reads the same gate, so the action and
 * the plan never disagree.
 */
export function publishRecordsOf(db: CrewReader, sourceId: string): PublishRecords {
  const source = db.select().from(workSources).where(eq(workSources.id, sourceId)).all()[0];
  const branch = integrationBranchOf(db, sourceId);
  const condition = branchCondition(db, sourceId);
  const empty: PublishRecords = {
    sourceId,
    repository:
      source?.trackerLocation == null
        ? null
        : storedTrackerLocation(source.trackerLocation).repository,
    slug: sourceSlug(sourceId),
    base: branch?.baseCommit ?? null,
    head: branch?.recordedTip ?? null,
    commits: [],
    gatingReview: null,
    text: null,
    verified: { gateCommands: [], gateRuns: [], reviews: [] },
    rejected: [],
    deferred: [],
    refusals: [],
  };
  if (branch === null) {
    return {
      ...empty,
      refusals: [
        { reason: "nothing_to_publish", detail: `Source ${sourceId} has no integration branch.` },
      ],
    };
  }

  const commits =
    condition.status === "due" || condition.status === "one-commit" ? condition.commits : [];
  const isBranch = condition.status === "due";
  const gatingReview = gatingReviewOf(db, sourceId, condition);

  const baseGate = baseGateOf(db, sourceId);
  const commitRuns = commits.map((one) => ({
    commit: one.commit,
    run: passingRunAt(db, sourceId, one.commit),
  }));
  const headRun = commitRuns.at(-1)?.run ?? null;
  const gateRefusals: RecordRefusal[] = [
    ...(baseGate.status === "passed" && baseGate.commit === branch.baseCommit
      ? []
      : [
          {
            reason: "gate_base_not_passed" as const,
            detail: `No passing gate run is recorded at the integration base ${branch.baseCommit}.`,
          },
        ]),
    ...commitRuns
      .filter((one) => one.run === null)
      .map((one) => ({
        reason: "gate_commit_not_passed" as const,
        detail: `No passing gate run is recorded at commit ${one.commit}.`,
      })),
  ];

  const final = condition.status === "due" || condition.status === "one-commit";
  const refusals: RecordRefusal[] = [
    ...(final && commits.length > 0
      ? reviewRefusals(db, gatingReview, isBranch, headRun)
      : final
        ? []
        : [
            {
              reason: "branch_review_missing" as const,
              detail:
                condition.status === "not-final"
                  ? `The integration branch is not final: ${condition.pending.map((one) => `${one.assignmentId} is ${one.state}`).join(", ")}.`
                  : "The integration branch is not final.",
            },
          ]),
    ...(commits.length > 0 ? gateRefusals : []),
    ...openRefusals(db, sourceId, condition),
    // A branch with no commit above its base has nothing to publish (decision 30).
    ...(branch.recordedTip === branch.baseCommit
      ? [
          {
            reason: "nothing_to_publish" as const,
            detail: `The integration branch of ${sourceId} holds no commit above its base.`,
          },
        ]
      : []),
  ];

  const resultReviews = commits.flatMap((one) => {
    const review = reviewOfSubmission(db, one.submissionId);
    return review === null ? [] : [{ review, commit: one.commit }];
  });
  const branchReview = isBranch ? gatingReview : null;

  return {
    ...empty,
    commits: commits.map((one) => gatedCommit(db, one)),
    gatingReview,
    text:
      gatingReview?.publishedText == null ? null : storedPublishedText(gatingReview.publishedText),
    verified: {
      gateCommands: fixedGateOf(branch).commands.map((one) => ProjectGate.commandLine(one.argv)),
      gateRuns: [
        ...(baseGate.status === "passed"
          ? [{ runId: baseGate.run.id, commit: baseGate.commit, at: "base" as const }]
          : []),
        ...commitRuns.flatMap((one) =>
          one.run === null
            ? []
            : [{ runId: one.run.id, commit: one.commit, at: "commit" as const }],
        ),
      ],
      reviews: [
        ...resultReviews.map((one) => ({
          kind: "result" as const,
          reviewId: one.review.id,
          subject: `commit ${one.commit.slice(0, 12)}`,
          host: one.review.host ?? "an unrecorded host",
        })),
        ...(branchReview === null
          ? []
          : [
              {
                kind: "branch" as const,
                reviewId: branchReview.id,
                subject: `the head ${branch.recordedTip.slice(0, 12)}`,
                host: branchReview.host ?? "an unrecorded host",
              },
            ]),
      ],
    },
    ...answeredFindings(db, resultReviews, branchReview),
    refusals,
  };
}
