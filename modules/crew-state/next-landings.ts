import { and, eq } from "drizzle-orm";
import type { CrewReader } from "./database.ts";
import { candidateGateOf } from "./gate-runs.ts";
import { integrationBranchOf, type IntegrationBranchRow } from "./integration.ts";
import { intendedLandingOf, planLanding, replacedLandingOf, type LandingRow } from "./landing.ts";
import { readState } from "./operations.ts";
import { planRewrite, type RangeGate, rangeGateOf } from "./rewrite.ts";
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
  // The landing a correction replaces, or null for an ordinary landing.
  replaced: LandingRow | null;
};

/** Where the rebuilt range of one correction stands at the project gate, read from its plan. */
export type RewriteRead = { branch: string; replaced: string; gate: RangeGate };

/**
 * The code results whose landing `crew next` would otherwise offer to gate: awaiting review, with
 * no open cycle and no intent of their own. An ordinary landing with a gate run at the recorded
 * tip has a candidate already. A correction of a landed commit is planned as a rewrite.
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
      const replaced = replacedLandingOf(db, {
        assignmentId: assignment.id,
        submissionId: submission.id,
      });
      if (
        openCycleOf(db, assignment.id) !== null ||
        intended?.submissionId === submission.id ||
        (replaced === null &&
          candidateGateOf(db, {
            sourceId: assignment.sourceId,
            submissionId: submission.id,
            tip: row.recordedTip,
          }).status !== "pending")
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
          replaced,
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
export async function readBrokenLandings(projectRoot: string): Promise<{
  broken: Map<string, BrokenLanding>;
  rewrites: Map<string, RewriteRead>;
}> {
  const read = await readState(projectRoot, candidatesOf);
  const broken = new Map<string, BrokenLanding>();
  const rewrites = new Map<string, RewriteRead>();
  if (!Array.isArray(read)) {
    return { broken, rewrites };
  }
  for (const one of read) {
    if (one.replaced !== null) {
      // A correction lands on the parent of the commit it replaces, so that is the tip it names.
      const subject = { branch: one.row.name, tip: one.replaced.landedParent, commit: one.commit };
      const planned = await planRewrite({ projectRoot, ...one, replaced: one.replaced });
      if (planned.status === "landing-conflict") {
        broken.set(one.submissionId, { cause: "conflict", ...subject, paths: planned.paths });
      } else if (planned.status === "landing-patch-changed") {
        broken.set(one.submissionId, { cause: "patch-changed", ...subject, paths: [] });
      } else if (planned.status === "planned") {
        const gated = await readState(projectRoot, (db) => ({
          gate: rangeGateOf(db, planned.rewrite),
        }));
        if ("gate" in gated) {
          rewrites.set(one.submissionId, {
            branch: one.row.name,
            replaced: one.replaced.landedCommit,
            gate: gated.gate,
          });
        }
      }
      continue;
    }
    const planned = await planLanding({ projectRoot, ...one });
    const subject = { branch: one.row.name, tip: one.row.recordedTip, commit: one.commit };
    if (planned.status === "landing-conflict") {
      broken.set(one.submissionId, { cause: "conflict", ...subject, paths: planned.paths });
    } else if (planned.status === "landing-patch-changed") {
      broken.set(one.submissionId, { cause: "patch-changed", ...subject, paths: [] });
    }
  }
  return { broken, rewrites };
}
