import { eq } from "drizzle-orm";
import type { CrewReader, CrewWriter } from "./database.ts";
import { identityOf } from "./identity.ts";
import { reviewFindings, reviewReports, reviews } from "./schema.ts";

export const REVIEW_AXES = ["standards", "spec"] as const;

export type ReviewAxis = (typeof REVIEW_AXES)[number];

/** A review is registered until it either reports both axes or records what stopped it. */
export type ReviewState = "registered" | "reported" | "blocked";

export type ReviewRow = typeof reviews.$inferSelect;
export type ReviewReportRow = typeof reviewReports.$inferSelect;
export type ReviewFindingRow = typeof reviewFindings.$inferSelect;

export function readReview(db: CrewReader, id: string): ReviewRow | null {
  return db.select().from(reviews).where(eq(reviews.id, id)).all()[0] ?? null;
}

/** The review one review assignment carries. A review assignment holds exactly one. */
export function reviewOfAssignment(db: CrewReader, assignmentId: string): ReviewRow | null {
  return db.select().from(reviews).where(eq(reviews.assignmentId, assignmentId)).all()[0] ?? null;
}

/** The review that examines one submission. */
export function reviewOfSubmission(db: CrewReader, submissionId: string): ReviewRow | null {
  return (
    db
      .select()
      .from(reviews)
      .where(eq(reviews.submissionId, submissionId))
      .all()
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null
  );
}

export function reportsOf(db: CrewReader, reviewId: string): ReviewReportRow[] {
  return db
    .select()
    .from(reviewReports)
    .where(eq(reviewReports.reviewId, reviewId))
    .all()
    .toSorted((left, right) => left.axis.localeCompare(right.axis));
}

export function findingsOf(db: CrewReader, reviewId: string): ReviewFindingRow[] {
  return db
    .select()
    .from(reviewFindings)
    .where(eq(reviewFindings.reviewId, reviewId))
    .all()
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

/** A finding is named by its review, axis, and reporter key, so the Operator can address it. */
export function findingId(reviewId: string, axis: string, key: string): string {
  return identityOf({ reviewId, axis, key }).slice(0, 32);
}

/** The axes this release requires but the review has not reported. */
export function missingAxes(reports: ReviewReportRow[]): string[] {
  return REVIEW_AXES.filter((axis) => !reports.some((report) => report.axis === axis));
}

export function updateReview(
  db: CrewWriter,
  request: {
    review: ReviewRow;
    state: ReviewState;
    host: string;
    subAgents: unknown;
    blocker: unknown;
    reportedAt: string | null;
    now: string;
  },
): void {
  db.update(reviews)
    .set({
      state: request.state,
      host: request.host,
      subAgents: request.subAgents === null ? null : JSON.stringify(request.subAgents),
      blocker: request.blocker === null ? null : JSON.stringify(request.blocker),
      reportedAt: request.reportedAt,
      revision: request.review.revision + 1,
      updatedAt: request.now,
    })
    .where(eq(reviews.id, request.review.id))
    .run();
}

/**
 * Returns one unfinished review to registered so a replacement attempt can report it.
 * A blocked review is a stopped review, not a verdict, so the crew may try it again under the
 * replacement limit. A reported review is finished and is never reopened this way.
 */
export function reopenReview(db: CrewWriter, request: { review: ReviewRow; now: string }): void {
  db.update(reviews)
    .set({
      state: "registered",
      host: null,
      subAgents: null,
      blocker: null,
      reportedAt: null,
      revision: request.review.revision + 1,
      updatedAt: request.now,
    })
    .where(eq(reviews.id, request.review.id))
    .run();
}
