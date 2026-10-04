import { eq } from "drizzle-orm";
import type { CrewReader, CrewWriter } from "./database.ts";
import { type AttemptRow, endAttempt } from "./attempt.ts";
import { Attempt, type SubmitRefusal } from "./attempt-machine.ts";
import {
  type AssignmentRow,
  insertAssignment,
  moveAssignment,
  nextOrderIndex,
} from "./assignment.ts";
import { identityOf } from "./identity.ts";
import { assignments, landings, reviews, submissions } from "./schema.ts";
import { REVIEW_AXES } from "./review.ts";
import { closeCycle, openCycleOf } from "./rework.ts";
import { storedRequirements } from "./work-input.ts";
import { type outsideChangesOf, recordOutsideChanges } from "./outside-changes.ts";
import { type SubmissionInput, storedCode } from "./submission-input.ts";
import {
  type IntegrationInputs,
  INTERDIFF_INPUT,
  REVIEWED_PATCH_INPUT,
  type StoredArtifact,
  type StoredCopy,
} from "./submission-store.ts";

export type SubmissionRow = typeof submissions.$inferSelect;

/** The Operator commands every reviewer runs, whatever the result it reads. */
export const REVIEWER_COMMANDS = ["operator attempt acknowledge", "operator review report"];

/**
 * The read-only `git` commands that `code-review` runs from its fixed point.
 * A result review diffs from the base commit, so the diff is exactly the one submitted commit.
 * Only these are named, because any other `git` command lets a reviewer write, and only the
 * checkout reading after the review would see it (ADR 0007).
 */
export function reviewReadCommands(fixedPoint: string | null): string[] {
  return fixedPoint === null
    ? []
    : [
        `git rev-parse ${fixedPoint}`,
        `git diff ${fixedPoint}...HEAD`,
        `git log ${fixedPoint}..HEAD --oneline`,
      ];
}

export type SubmitOutcome =
  | {
      status: "submitted";
      submissionId: string;
      assignmentId: string;
      attemptId: string;
      revision: number;
      identity: string;
      reviewId: string;
      reviewAssignmentId: string;
      reviewSourceKey: string;
      // The delegated cycle this result answers, when the assignment was in rework.
      reworkCycleId: string | null;
      // How many outside changes wait for a disposition before acceptance.
      outsideChanges: number;
    }
  | SubmitRefusal;

export function readSubmission(db: CrewReader, id: string): SubmissionRow | null {
  return db.select().from(submissions).where(eq(submissions.id, id)).all()[0] ?? null;
}

export function submissionOfAttempt(db: CrewReader, attemptId: string): SubmissionRow | null {
  return db.select().from(submissions).where(eq(submissions.attemptId, attemptId)).all()[0] ?? null;
}

/** Every submission of one assignment, oldest first. Rework submits again under a new revision. */
export function submissionsOf(db: CrewReader, assignmentId: string): SubmissionRow[] {
  return db
    .select()
    .from(submissions)
    .where(eq(submissions.assignmentId, assignmentId))
    .all()
    .toSorted((left, right) => left.assignmentRevision - right.assignmentRevision);
}

/** The most recent submission of one assignment. Rework submits again under a new revision. */
export function latestSubmission(db: CrewReader, assignmentId: string): SubmissionRow | null {
  return submissionsOf(db, assignmentId).at(-1) ?? null;
}

/** The commit one submission handed over, or null for a result that is not code. */
export function submittedCommit(row: SubmissionRow): string | null {
  return row.code === null ? null : storedCode(row.code).resultCommit;
}

/**
 * The commit on the integration branch that carries the accepted code result of one assignment,
 * and its parent there, or null. A result that an earlier release accepted recorded no landing,
 * so its reviewed commit is the commit that carries it.
 */
export function landedCommitOf(
  db: CrewReader,
  submission: SubmissionRow,
): { commit: string; parent: string | null } | null {
  const landed = db
    .select()
    .from(landings)
    .where(eq(landings.submissionId, submission.id))
    .all()
    .find((one) => one.state === "landed" || one.state === "merged");
  if (landed !== undefined) {
    return { commit: landed.landedCommit, parent: landed.landedParent };
  }
  const commit = submittedCommit(submission);
  return commit === null
    ? null
    : { commit, parent: submission.code === null ? null : storedCode(submission.code).baseCommit };
}

/**
 * The commit the reviewed change of one code submission starts from. A findings cycle or a
 * diagnostic rerun starts on the commit an earlier submission handed over, so its change runs
 * from the base of the first submission of that chain, as an amended commit would. A correction
 * of accepted work starts at the commit on the branch that carries the result, so its change
 * runs from the parent of that commit there.
 */
export function reviewedBaseOf(db: CrewReader, submission: SubmissionRow): string | null {
  if (submission.code === null) {
    return null;
  }
  const earlier = new Map<string, string>();
  for (const one of submissionsOf(db, submission.assignmentId)) {
    if (one.id !== submission.id && one.code !== null) {
      const code = storedCode(one.code);
      earlier.set(code.resultCommit, code.baseCommit);
    }
  }
  for (const one of db
    .select()
    .from(landings)
    .where(eq(landings.assignmentId, submission.assignmentId))
    .all()) {
    // A held landing names a commit that another result put on the branch, so it is no start.
    const carried = ["landed", "merged", "replaced", "taken-out"].includes(one.state);
    if (one.submissionId !== submission.id && carried && one.kind !== "held") {
      earlier.set(one.landedCommit, one.landedParent);
    }
  }
  let base = storedCode(submission.code).baseCommit;
  const seen = new Set<string>();
  while (earlier.has(base) && !seen.has(base)) {
    seen.add(base);
    base = earlier.get(base) ?? base;
  }
  return base;
}

/** The commit that carries the accepted code result of one assignment, or null. */
export function recordedLanding(db: CrewReader, assignmentId: string): string | null {
  const accepted = submissionsOf(db, assignmentId).filter((one) => one.state === "accepted");
  const last = accepted.at(-1);
  return last === undefined ? null : (landedCommitOf(db, last)?.commit ?? null);
}

/**
 * The rules submit refuses here, in the order it checks them, each with the refusal name the CLI
 * reports for it. The brief places these lines beside the submit command and words none itself.
 */
export const SUBMIT_RULES = [
  {
    refusal: "stale_revision",
    rule: "`assignmentRevision` is the assignment revision in the Identity section.",
  },
  {
    refusal: "source_revision_changed",
    rule: "`sourceRevision` is the source revision in the Identity section.",
  },
  {
    refusal: "requirements_changed",
    rule: "`requirementsIdentity` is the requirements identity under Acceptance requirements.",
  },
];

/** The identity of the acceptance requirements one assignment holds. */
function requirementsIdentityOf(assignment: AssignmentRow): string {
  return identityOf(storedRequirements(assignment.acceptanceRequirements));
}

/**
 * Registers the review assignment of one submission.
 * Review is ordinary crew work: it is claimed, dispatched, and accounted for through the same
 * frontier, so the reviewer holds one Herdr slot and its own worktree.
 */
function registerReview(
  db: CrewWriter,
  request: {
    producer: AssignmentRow;
    submissionId: string;
    submissionIdentity: string;
    reviewId: string;
    input: SubmissionInput;
    artifacts: StoredArtifact[];
    spec: StoredCopy;
    integration: IntegrationInputs | null;
    // The project gate commands as lines, which the reviewer is permitted to run.
    gateCommands: string[];
    now: string;
  },
): { assignmentId: string; sourceKey: string } {
  const held = db
    .select()
    .from(assignments)
    .where(eq(assignments.sourceId, request.producer.sourceId))
    .all();
  const round =
    held.filter((row) => row.sourceKey.startsWith(`${request.producer.sourceKey}#review.`)).length +
    1;
  const sourceKey = `${request.producer.sourceKey}#review.${round}`;
  // A reviewer reports through the CLI, so the brief authorizes those commands as well as the
  // checks it may re-run. A result that recorded no check still leaves the reviewer able to report.
  const commands = [
    ...new Set([
      ...REVIEWER_COMMANDS,
      ...reviewReadCommands(request.input.code?.baseCommit ?? null),
      ...request.gateCommands,
      ...request.input.checks.map((one) => one.command),
    ]),
  ];

  const fixedInputs = [
    {
      name: "submission",
      kind: "value",
      value: request.submissionId,
      contentIdentity: request.submissionIdentity,
    },
    {
      name: "result-kind",
      kind: "value",
      value: request.input.resultKind,
      contentIdentity: null,
    },
    ...request.artifacts.map((artifact) => ({
      name: artifact.name,
      kind: artifact.kind,
      value: artifact.storedPath ?? artifact.value,
      contentIdentity: artifact.contentIdentity,
    })),
    {
      name: "spec",
      kind: "path",
      value: request.spec.storedPath,
      contentIdentity: request.spec.contentIdentity,
    },
    // A combined revision of an integration cycle is reviewed with the patch that was reviewed
    // and the interdiff from it to the new one (ADR 0017).
    ...(request.integration === null
      ? []
      : [
          {
            name: REVIEWED_PATCH_INPUT,
            kind: "path",
            value: request.integration.reviewedPatch.storedPath,
            contentIdentity: request.integration.reviewedPatch.contentIdentity,
          },
          {
            name: INTERDIFF_INPUT,
            kind: "path",
            value: request.integration.interdiff.storedPath,
            contentIdentity: request.integration.interdiff.contentIdentity,
          },
        ]),
  ];

  const row = insertAssignment(
    db,
    {
      sourceId: request.producer.sourceId,
      sourceKey,
      sourceRevision: request.producer.sourceRevision,
      // A review is crew work, not a registered ticket, so it carries no binding of its own.
      trackerBinding: null,
      title: `Review ${request.producer.title}`,
      kind: "review",
      planningType: null,
      orderIndex: nextOrderIndex(held),
      approvedScope: `Review submission ${request.submissionId} of assignment ${request.producer.id} on the Standards and Spec axes.`,
      scopeIdentity: null,
      acceptanceRequirements: [
        `Record one Standards report and one Spec report for submission ${request.submissionId}.`,
        "Run both axes as native sub-agents of this host, in parallel and in separate contexts.",
        "Never edit, commit, push, or rework the submitted result.",
      ],
      // A reviewer writes its own report and nothing else, so rework can never hide inside it.
      permissions: {
        writePaths: [".operator/local/"],
        allowedCommands: commands,
        network: false,
      },
      fixedInputs,
    },
    request.now,
  );

  db.insert(reviews)
    .values({
      id: request.reviewId,
      submissionId: request.submissionId,
      snapshotId: null,
      assignmentId: row.id,
      axes: JSON.stringify(REVIEW_AXES),
      state: "registered",
      host: null,
      subAgents: null,
      blocker: null,
      reportedAt: null,
      revision: 1,
      createdAt: request.now,
      updatedAt: request.now,
    })
    .run();

  return { assignmentId: row.id, sourceKey };
}

/**
 * Records one fixed result and hands it to a separate review.
 * The assignment moves to awaiting review, never to accepted completion, and the attempt ends,
 * so the crew slot it held becomes free for the reviewer.
 */
export function submitResult(
  db: CrewWriter,
  request: {
    attempt: AttemptRow;
    assignment: AssignmentRow;
    input: SubmissionInput;
    artifacts: StoredArtifact[];
    spec: StoredCopy;
    integration: IntegrationInputs | null;
    // What the scans around the worktree found. Submit records them and never refuses for them.
    outside: ReturnType<typeof outsideChangesOf>;
    gateCommands: string[];
    submissionId: string;
    reviewId: string;
    now: string;
  },
): SubmitOutcome {
  const { assignment, attempt, input } = request;

  const decision = Attempt.decide("submit", {
    attemptId: attempt.id,
    assignment,
    stated: input,
    requirementsIdentity: requirementsIdentityOf(assignment),
    held: submissionOfAttempt(db, attempt.id),
  });
  if ("refused" in decision) {
    return decision.refused;
  }

  const artifacts = request.artifacts;
  const identity = identityOf({
    assignmentId: assignment.id,
    attemptId: attempt.id,
    resultKind: input.resultKind,
    assignmentRevision: input.assignmentRevision,
    sourceRevision: input.sourceRevision,
    requirementsIdentity: input.requirementsIdentity,
    artifacts,
    checks: input.checks,
    concerns: input.concerns,
    decisions: input.decisions,
    behaviorChanges: input.behaviorChanges,
    code: input.code ?? null,
    outsideChanges: request.outside,
  });

  db.insert(submissions)
    .values({
      id: request.submissionId,
      assignmentId: assignment.id,
      attemptId: attempt.id,
      resultKind: input.resultKind,
      assignmentRevision: input.assignmentRevision,
      sourceRevision: input.sourceRevision,
      requirementsIdentity: input.requirementsIdentity,
      artifacts: JSON.stringify(artifacts),
      artifactsIdentity: identityOf(artifacts),
      checks: JSON.stringify(input.checks),
      concerns: JSON.stringify(input.concerns),
      decisions: JSON.stringify(input.decisions),
      behaviorChanges: JSON.stringify(input.behaviorChanges),
      code: input.code === null ? null : JSON.stringify(input.code),
      // A code review starts from the exact commit the result lives on, never a moving branch.
      reviewBase: input.code?.resultCommit ?? null,
      identity,
      state: "awaiting-review",
      revision: 1,
      submittedAt: request.now,
      updatedAt: request.now,
    })
    .run();
  recordOutsideChanges(db, {
    submissionId: request.submissionId,
    changes: request.outside,
    now: request.now,
  });

  // A combined revision closes the cycle it answers, and names the fresh Operative that did it.
  const cycle = openCycleOf(db, assignment.id);
  if (cycle !== null) {
    closeCycle(db, { cycle, attemptId: attempt.id, now: request.now });
  }

  endAttempt(db, { attempt, state: decision.next, now: request.now });

  const revision = moveAssignment(db, {
    row: assignment,
    state: "awaiting-review",
    now: request.now,
  });

  const registered = registerReview(db, {
    producer: assignment,
    submissionId: request.submissionId,
    submissionIdentity: identity,
    reviewId: request.reviewId,
    input,
    artifacts,
    spec: request.spec,
    integration: request.integration,
    gateCommands: request.gateCommands,
    now: request.now,
  });

  return {
    status: "submitted",
    submissionId: request.submissionId,
    assignmentId: assignment.id,
    attemptId: attempt.id,
    revision,
    identity,
    reviewId: request.reviewId,
    reviewAssignmentId: registered.assignmentId,
    reviewSourceKey: registered.sourceKey,
    reworkCycleId: cycle?.id ?? null,
    outsideChanges: request.outside.length,
  };
}
