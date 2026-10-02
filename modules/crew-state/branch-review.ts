import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { ProjectGate } from "../project-gate/main.ts";
import {
  type AssignmentRow,
  insertAssignment,
  nextOrderIndex,
  readAssignment,
} from "./assignment.ts";
import type { CrewReader, CrewWriter } from "./database.ts";
import { type DirectionRecord, raiseDirection } from "./direction.ts";
import { identityOf } from "./identity.ts";
import { fixedGateOf, integrationBranchOf } from "./integration.ts";
import { sourceTextOf } from "./requirement-source.ts";
import { REVIEW_AXES, reviewOfSubmission, type ReviewRow } from "./review.ts";
import { assignments, branchSnapshots, landings, reviews } from "./schema.ts";
import { readStored } from "./stored.ts";
import { type StoredCopy, specPathOf } from "./submission-store.ts";
import {
  REVIEWER_COMMANDS,
  reviewReadCommands,
  type SubmissionRow,
  submissionsOf,
} from "./submission.ts";
import { storedResultKind } from "./submission-input.ts";
import { storedFixedInputs } from "./work-input.ts";

/**
 * One source holds three branch reviews that reported, whatever changed the head between them.
 * The fourth waits on a direction request, so publish waits on the user (ADR 0008, ADR 0017).
 */
export const BRANCH_REVIEW_LIMIT = 3;

/** The source keys of the branch reviews of a source start with this, one number each. */
const BRANCH_REVIEW_KEY = "branch-review.";

/** One commit of a branch snapshot, in branch order, with the accepted submission it carries. */
const snapshotCommit = z.strictObject({
  assignmentId: z.string(),
  sourceKey: z.string(),
  title: z.string(),
  submissionId: z.string(),
  commit: z.string(),
});

export type SnapshotCommit = z.infer<typeof snapshotCommit>;

export type BranchSnapshotRow = typeof branchSnapshots.$inferSelect;

export function storedSnapshotCommits(stored: string): SnapshotCommit[] {
  return readStored("snapshot commit list", z.array(snapshotCommit), stored);
}

export function readSnapshot(db: CrewReader, id: string): BranchSnapshotRow | null {
  return db.select().from(branchSnapshots).where(eq(branchSnapshots.id, id)).all()[0] ?? null;
}

/** True when this review reads a branch snapshot rather than one submission. */
export function isBranchReview(review: ReviewRow): boolean {
  return review.snapshotId !== null;
}

/** Every branch review of one source, oldest first, with the snapshot it reads. */
export function branchReviewsOf(
  db: CrewReader,
  sourceId: string,
): Array<{ review: ReviewRow; snapshot: BranchSnapshotRow }> {
  const snapshots = db
    .select()
    .from(branchSnapshots)
    .where(eq(branchSnapshots.sourceId, sourceId))
    .all();
  if (snapshots.length === 0) {
    return [];
  }
  const byId = new Map(snapshots.map((one) => [one.id, one]));
  return db
    .select()
    .from(reviews)
    .where(
      inArray(
        reviews.snapshotId,
        snapshots.map((one) => one.id),
      ),
    )
    .all()
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .flatMap((review) => {
      const snapshot = byId.get(review.snapshotId ?? "");
      return snapshot === undefined ? [] : [{ review, snapshot }];
    });
}

/**
 * The branch reviews of one source that count toward its limit. A blocked review is a stopped
 * review, not a round, and a withdrawn one never reported, so only a reported one counts.
 */
export function reportedRounds(db: CrewReader, sourceId: string): ReviewRow[] {
  return branchReviewsOf(db, sourceId)
    .map((one) => one.review)
    .filter((review) => review.state === "reported");
}

/**
 * The commits on the integration branch, in the order they landed, each with the accepted
 * submission of its assignment. It reads only the recorded landings, never Git.
 */
function landedCommits(db: CrewReader, rows: AssignmentRow[]): SnapshotCommit[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const landed = db
    .select()
    .from(landings)
    .where(eq(landings.state, "landed"))
    .all()
    .filter((one) => byId.has(one.assignmentId))
    .toSorted(
      (left, right) =>
        (left.landedAt ?? left.createdAt).localeCompare(right.landedAt ?? right.createdAt) ||
        left.createdAt.localeCompare(right.createdAt),
    );

  // The first landing of an assignment gives its place, and the latest gives its commit.
  const order: string[] = [];
  const latest = new Map<string, (typeof landed)[number]>();
  for (const one of landed) {
    if (!latest.has(one.assignmentId)) {
      order.push(one.assignmentId);
    }
    latest.set(one.assignmentId, one);
  }

  return order.flatMap((assignmentId) => {
    const row = byId.get(assignmentId);
    const landing = latest.get(assignmentId);
    const accepted = row === undefined ? null : acceptedSubmissionId(db, row.id);
    return row === undefined || landing === undefined || accepted === null
      ? []
      : [
          {
            assignmentId: row.id,
            sourceKey: row.sourceKey,
            title: row.title,
            submissionId: accepted,
            commit: landing.landedCommit,
          },
        ];
  });
}

/** The newest accepted submission of one assignment, which is the result its commit carries. */
function acceptedSubmissionId(db: CrewReader, assignmentId: string): string | null {
  return (
    submissionsOf(db, assignmentId)
      .filter((one) => one.state === "accepted")
      .at(-1)?.id ?? null
  );
}

/**
 * The fixed spec copy of one submission, as its result review received it. A result review
 * registered before that copy existed carries none, so neither does the branch review.
 */
function specCopyOf(db: CrewReader, submissionId: string): StoredCopy | null {
  const review = reviewOfSubmission(db, submissionId);
  const holder = review === null ? null : readAssignment(db, review.assignmentId);
  const path = specPathOf(submissionId);
  const spec =
    holder === null
      ? undefined
      : storedFixedInputs(holder.fixedInputs).find(
          (one) => one.kind === "path" && one.value === path,
        );
  return spec?.contentIdentity == null
    ? null
    : { storedPath: spec.value, contentIdentity: spec.contentIdentity };
}

/** Why a source owes no branch review now. Each one reads the recorded state only. */
export type BranchCondition =
  | {
      status: "due";
      sourceId: string;
      baseCommit: string;
      headCommit: string;
      commits: SnapshotCommit[];
      identity: string;
    }
  | { status: "no-branch" }
  | { status: "not-final"; pending: Array<{ assignmentId: string; state: string }> }
  | { status: "take-out-pending"; assignmentIds: string[] }
  | { status: "one-commit"; baseCommit: string; headCommit: string; commits: SnapshotCommit[] };

/**
 * Reads whether the integration branch of one source is final, and the snapshot it then holds.
 * It is final when every code assignment that is not withdrawn is accepted, so an invalidated,
 * paused, or reworked one holds it, and so does a withdrawn commit that the branch still holds.
 * A source whose one code commit carries its only item has no branch review (ADR 0017).
 */
export function branchCondition(db: CrewReader, sourceId: string): BranchCondition {
  const branch = integrationBranchOf(db, sourceId);
  if (branch === null) {
    return { status: "no-branch" };
  }
  const production = db
    .select()
    .from(assignments)
    .where(and(eq(assignments.sourceId, sourceId), eq(assignments.kind, "production")))
    .all();
  const live = production.filter((row) => row.state !== "withdrawn");
  const pending = live
    .filter((row) => row.state !== "accepted")
    .map((row) => ({ assignmentId: row.id, state: row.state }));
  if (pending.length > 0) {
    return { status: "not-final", pending };
  }

  // The take-out of a withdrawn commit rebuilds the branch, so until it runs the head is not final.
  const withdrawn = production.filter((row) => row.state === "withdrawn");
  const held = landedCommits(db, withdrawn).map((one) => one.assignmentId);
  if (held.length > 0) {
    return { status: "take-out-pending", assignmentIds: held };
  }

  const commits = landedCommits(db, live);
  if (commits.length === 0 || (commits.length === 1 && live.length === 1)) {
    return {
      status: "one-commit",
      baseCommit: branch.baseCommit,
      headCommit: branch.recordedTip,
      commits,
    };
  }

  const subject = {
    sourceId,
    baseCommit: branch.baseCommit,
    headCommit: branch.recordedTip,
    commits,
  };
  return { status: "due", ...subject, identity: identityOf(subject) };
}

/**
 * True when one submission is the code result of the only code item of its source that is not
 * withdrawn. Such a source has no branch review, so its result review writes the published text.
 */
export function publishesAlone(db: CrewReader, submission: SubmissionRow): boolean {
  if (storedResultKind(submission.resultKind) !== "code") {
    return false;
  }
  const holder = readAssignment(db, submission.assignmentId);
  if (holder === null || holder.kind !== "production") {
    return false;
  }
  const live = db
    .select({ id: assignments.id, state: assignments.state })
    .from(assignments)
    .where(and(eq(assignments.sourceId, holder.sourceId), eq(assignments.kind, "production")))
    .all()
    .filter((row) => row.state !== "withdrawn");
  return live.length === 1 && live[0]?.id === holder.id;
}

export type RegisteredBranchReview = {
  reviewId: string;
  assignmentId: string;
  sourceKey: string;
  snapshotId: string;
  snapshotIdentity: string;
  headCommit: string;
  round: number;
  // The request the fourth review waits on, or null while the source is inside its limit.
  direction: DirectionRecord | null;
};

/**
 * The fixed inputs of one branch review: its snapshot, the fixed text of the source, and the spec
 * copy of each item. Together the two texts are the spec of the source (ADR 0017).
 */
function fixedInputsOf(
  db: CrewReader,
  request: { sourceId: string; snapshotId: string; identity: string; commits: SnapshotCommit[] },
) {
  const source = sourceTextOf(db, request.sourceId);
  return [
    {
      name: "branch-snapshot",
      kind: "value",
      value: request.snapshotId,
      contentIdentity: request.identity,
    },
    ...(source === null
      ? []
      : [
          {
            name: "spec source",
            kind: "path",
            value: source.storedPath,
            contentIdentity: source.contentIdentity,
          },
        ]),
    ...request.commits.flatMap((one) => {
      const spec = specCopyOf(db, one.submissionId);
      return spec === null
        ? []
        : [
            {
              name: `spec ${one.sourceKey}`,
              kind: "path",
              value: spec.storedPath,
              contentIdentity: spec.contentIdentity,
            },
          ];
    }),
  ];
}

/**
 * Registers the branch review of one source when its integration branch became final, in the
 * same change as the acceptance or the withdrawal that made it final. `crew next` only reads it.
 * A snapshot that a branch review already reads registers nothing, so a repeat is harmless.
 * The fourth review after three reported rounds is registered with a direction request, which
 * holds its dispatch until the user directs it.
 */
export function registerBranchReview(
  db: CrewWriter,
  request: { sourceId: string; now: string },
): RegisteredBranchReview | null {
  const condition = branchCondition(db, request.sourceId);
  if (condition.status !== "due") {
    return null;
  }
  const earlier = branchReviewsOf(db, request.sourceId);
  if (
    earlier.some(
      (one) => one.review.state !== "withdrawn" && one.snapshot.identity === condition.identity,
    )
  ) {
    return null;
  }

  const branch = integrationBranchOf(db, request.sourceId);
  const held = db
    .select()
    .from(assignments)
    .where(eq(assignments.sourceId, request.sourceId))
    .all();
  const anchor = held.find((row) => row.kind === "production");
  if (branch === null || anchor === undefined) {
    return null;
  }

  const snapshotId = crypto.randomUUID();
  db.insert(branchSnapshots)
    .values({
      id: snapshotId,
      sourceId: request.sourceId,
      baseCommit: condition.baseCommit,
      headCommit: condition.headCommit,
      commits: JSON.stringify(condition.commits),
      identity: condition.identity,
      createdAt: request.now,
    })
    .run();

  const round = held.filter((row) => row.sourceKey.startsWith(BRANCH_REVIEW_KEY)).length + 1;
  const sourceKey = `${BRANCH_REVIEW_KEY}${round}`;
  // A branch reviewer reads the whole range from the base and may run the project gate at the
  // head. It writes only its own report, so a correction can never hide inside it.
  const commands = [
    ...new Set([
      ...REVIEWER_COMMANDS,
      ...reviewReadCommands(condition.baseCommit),
      ...fixedGateOf(branch).commands.map((one) => ProjectGate.commandLine(one.argv)),
    ]),
  ];
  const row = insertAssignment(
    db,
    {
      sourceId: request.sourceId,
      sourceKey,
      sourceRevision: anchor.sourceRevision,
      trackerBinding: null,
      title: `Review the integration branch ${branch.name}`,
      kind: "review",
      planningType: null,
      orderIndex: nextOrderIndex(held),
      approvedScope: `Review branch snapshot ${snapshotId} of source ${request.sourceId}, from base ${condition.baseCommit} to head ${condition.headCommit}, as a whole on the Standards and Spec axes.`,
      scopeIdentity: null,
      acceptanceRequirements: [
        `Record one Standards report and one Spec report for branch snapshot ${snapshotId}.`,
        "Run both axes as native sub-agents of this host, in parallel and in separate contexts.",
        "Name the target commits of each finding.",
        "Never edit, commit, push, or rework a commit of the branch.",
      ],
      permissions: {
        writePaths: [".operator/local/"],
        allowedCommands: commands,
        network: false,
      },
      fixedInputs: fixedInputsOf(db, {
        sourceId: request.sourceId,
        snapshotId,
        identity: condition.identity,
        commits: condition.commits,
      }),
    },
    request.now,
  );

  const reviewId = crypto.randomUUID();
  db.insert(reviews)
    .values({
      id: reviewId,
      submissionId: null,
      snapshotId,
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

  const rounds = reportedRounds(db, request.sourceId);
  const direction =
    rounds.length < BRANCH_REVIEW_LIMIT
      ? null
      : raiseDirection(db, {
          directionRequestId: crypto.randomUUID(),
          assignmentId: row.id,
          limitKind: "branch_reviews",
          limitValue: BRANCH_REVIEW_LIMIT,
          evidence: {
            used: rounds.length,
            detail: `Source ${request.sourceId} holds ${rounds.length} branch reviews that reported.`,
            attempted: rounds.map((one) => `branch review ${one.id}`),
          },
          now: request.now,
        });

  return {
    reviewId,
    assignmentId: row.id,
    sourceKey,
    snapshotId,
    snapshotIdentity: condition.identity,
    headCommit: condition.headCommit,
    round,
    direction,
  };
}

/**
 * Closes each registered branch review of one source whose snapshot holds a commit of the
 * withdrawn assignment and that no attempt holds. Its head can never be published, so it is
 * not a reported round. The withdrawal refuses while an attempt still holds one.
 */
export function closeBranchReviewsOf(
  db: CrewWriter,
  request: { row: AssignmentRow; now: string },
): AssignmentRow[] {
  const closed: AssignmentRow[] = [];
  for (const { review, snapshot } of branchReviewsOf(db, request.row.sourceId)) {
    const holds = storedSnapshotCommits(snapshot.commits).some(
      (one) => one.assignmentId === request.row.id,
    );
    if (!holds || review.state === "reported" || review.state === "withdrawn") {
      continue;
    }
    db.update(reviews)
      .set({ state: "withdrawn", revision: review.revision + 1, updatedAt: request.now })
      .where(eq(reviews.id, review.id))
      .run();
    const holder = readAssignment(db, review.assignmentId);
    if (holder !== null) {
      closed.push(holder);
    }
  }
  return closed;
}

/** The branch review assignments of one source whose snapshot holds a commit of one item. */
export function branchReviewHoldersOf(db: CrewReader, row: AssignmentRow): string[] {
  return branchReviewsOf(db, row.sourceId)
    .filter(({ snapshot }) =>
      storedSnapshotCommits(snapshot.commits).some((one) => one.assignmentId === row.id),
    )
    .map(({ review }) => review.assignmentId);
}
