import { and, eq } from "drizzle-orm";
import type { CrewReader } from "./database.ts";
import { candidateGateOf } from "./gate-runs.ts";
import { integrationBranchOf, type IntegrationBranchRow } from "./integration.ts";
import { intendedLandingOf, landedEarlier, planLanding } from "./landing.ts";
import { readState } from "./operations.ts";
import { openCycleOf } from "./rework.ts";
import { assignments } from "./schema.ts";
import { latestSubmission, reviewedBaseOf, submittedCommit } from "./submission.ts";

/** A landing that would land nothing as it was reviewed, read from its plan. */
export type BrokenLanding = {
  cause: "conflict" | "patch-changed";
  branch: string;
  tip: string;
  commit: string;
  paths: string[];
};

type Candidate = {
  assignmentId: string;
  submissionId: string;
  commit: string;
  reviewedBase: string;
  row: IntegrationBranchRow;
};

/**
 * The code results whose landing `crew next` would otherwise offer to gate: awaiting review, with
 * no open cycle, no intent of their own, no earlier landing, and no gate run at the recorded tip.
 */
function candidatesOf(db: CrewReader): Candidate[] {
  return db
    .select()
    .from(assignments)
    .where(and(eq(assignments.kind, "production"), eq(assignments.state, "awaiting-review")))
    .all()
    .flatMap((assignment) => {
      const submission = latestSubmission(db, assignment.id);
      const commit = submission === null ? null : submittedCommit(submission);
      const row = integrationBranchOf(db, assignment.sourceId);
      if (submission === null || commit === null || row === null) {
        return [];
      }
      const intended = intendedLandingOf(db, assignment.sourceId);
      if (
        openCycleOf(db, assignment.id) !== null ||
        intended?.submissionId === submission.id ||
        landedEarlier(db, { assignmentId: assignment.id, submissionId: submission.id }) ||
        candidateGateOf(db, {
          sourceId: assignment.sourceId,
          submissionId: submission.id,
          tip: row.recordedTip,
        }).status !== "pending"
      ) {
        return [];
      }
      return [
        {
          assignmentId: assignment.id,
          submissionId: submission.id,
          commit,
          reviewedBase: reviewedBaseOf(db, submission) ?? commit,
          row,
        },
      ];
    });
}

/**
 * Plans the landing of every code result that waits for its candidate gate (ADR 0020). A conflict
 * or a changed patch has no candidate to gate, so `crew next` offers the integration cycle
 * instead. The plan is deterministic and writes only Git objects that no ref names, so this
 * changes nothing that a person or the crew reads. Every other outcome is left to the gate run
 * and to acceptance, which plan again and name it.
 */
export async function readBrokenLandings(projectRoot: string): Promise<Map<string, BrokenLanding>> {
  const read = await readState(projectRoot, candidatesOf);
  const broken = new Map<string, BrokenLanding>();
  if (!Array.isArray(read)) {
    return broken;
  }
  for (const one of read) {
    const planned = await planLanding({ projectRoot, ...one });
    const subject = { branch: one.row.name, tip: one.row.recordedTip, commit: one.commit };
    if (planned.status === "landing-conflict") {
      broken.set(one.submissionId, { cause: "conflict", ...subject, paths: planned.paths });
    } else if (planned.status === "landing-patch-changed") {
      broken.set(one.submissionId, { cause: "patch-changed", ...subject, paths: [] });
    }
  }
  return broken;
}
