import { readAssignment } from "./assignment.ts";
import type { CrewReader } from "./database.ts";
import { commandsOfRun, type GateRunRow, keyStatus, readGateRun } from "./gate-runs.ts";
import { integrationBranchOf, type IntegrationBranchRow } from "./integration.ts";
import {
  candidateKey,
  type LandingRow,
  type PlanRefusal,
  planLanding,
  replacedLandingOf,
} from "./landing.ts";
import { readState, type StateFailure } from "./operations.ts";
import { planRewrite, rangeGateOf } from "./rewrite.ts";
import type { ReworkIntegration } from "./rework-input.ts";
import { latestSubmission, reviewedBaseOf, submittedCommit } from "./submission.ts";
import type { StoredArtifact } from "./submission-store.ts";

/** What an integration cycle carries, read from the landing plan before its transaction. */
export type IntegrationEvidence = {
  status: "evidence";
  submissionId: string;
  integration: ReworkIntegration;
  // The output of each command of the failed gate run, as fixed artifacts of the cycle.
  outputs: StoredArtifact[];
};

/**
 * The refusals of an integration cycle that the landing plan gives, members of the durable unions
 * of ADR 0011. Each one opens nothing and records nothing.
 */
export type IntegrationRefusal =
  | {
      status: "lands-cleanly";
      assignmentId: string;
      branch: string;
      tip: string;
      // The planned commit, which no failed or flaky run blocks.
      planned: string;
    }
  | { status: "no-landing"; assignmentId: string; submissionId: string }
  | { status: "integration-branch-missing"; assignmentId: string; sourceId: string }
  | Exclude<PlanRefusal, { status: "landing-conflict" | "landing-patch-changed" }>;

/** No evidence is read when the assignment holds no submitted result, so its own refusal stands. */
export type IntegrationRead = IntegrationEvidence | IntegrationRefusal | { status: "unread" };

/** True when the read stopped at the state file, so nothing about the landing was read. */
export function stateFailed(read: IntegrationRead | StateFailure): read is StateFailure {
  return read.status.startsWith("state-");
}

/** The output of each command of one gate run, so the cycle carries it as a fixed artifact. */
function outputsOf(db: CrewReader, run: GateRunRow): StoredArtifact[] {
  return commandsOfRun(db, run.id).flatMap((one) =>
    one.outputPath === null || one.outputIdentity === null
      ? []
      : [
          {
            name: `gate run ${run.id} ${one.name} output`,
            kind: "path" as const,
            value: one.outputPath,
            contentIdentity: one.outputIdentity,
            storedPath: one.outputPath,
          },
        ],
  );
}

/**
 * Plans the landing of the submitted commit of one assignment again (ADR 0020). The plan is
 * deterministic, so it gives what acceptance gave. A conflict, a changed patch, or a planned commit
 * whose key holds a failed or flaky run is what an integration cycle answers. A commit that would
 * land cleanly, with no such run, needs no cycle.
 */
export async function readIntegrationEvidence(request: {
  projectRoot: string;
  assignmentId: string;
}): Promise<IntegrationRead | StateFailure> {
  const read = await readState(request.projectRoot, (db) => {
    const assignment = readAssignment(db, request.assignmentId);
    const submission = assignment === null ? null : latestSubmission(db, assignment.id);
    if (assignment === null || submission === null) {
      return { status: "unread" as const };
    }
    const commit = submittedCommit(submission);
    return {
      status: "read" as const,
      assignment,
      submission,
      commit,
      reviewedBase: commit === null ? null : (reviewedBaseOf(db, submission) ?? commit),
      row: integrationBranchOf(db, assignment.sourceId),
      replaced: replacedLandingOf(db, { assignmentId: assignment.id, submissionId: submission.id }),
    };
  });
  if (read.status !== "read") {
    return read;
  }
  const { assignment, submission, commit, reviewedBase, row, replaced } = read;
  if (commit === null || reviewedBase === null) {
    return { status: "no-landing", assignmentId: assignment.id, submissionId: submission.id };
  }
  if (row === null) {
    return {
      status: "integration-branch-missing",
      assignmentId: assignment.id,
      sourceId: assignment.sourceId,
    };
  }

  if (replaced !== null) {
    return readRewriteEvidence({
      projectRoot: request.projectRoot,
      assignmentId: assignment.id,
      submissionId: submission.id,
      row,
      replaced,
      commit,
      reviewedBase,
    });
  }

  const planned = await planLanding({
    projectRoot: request.projectRoot,
    assignmentId: assignment.id,
    row,
    commit,
    reviewedBase,
  });
  const base = { branch: row.name, tip: row.recordedTip, commit };
  if (planned.status === "landing-conflict") {
    return {
      status: "evidence",
      submissionId: submission.id,
      integration: { ...base, cause: "conflict", paths: planned.paths, gateRunId: null },
      outputs: [],
    };
  }
  if (planned.status === "landing-patch-changed") {
    return {
      status: "evidence",
      submissionId: submission.id,
      integration: { ...base, cause: "patch-changed", paths: [], gateRunId: null },
      outputs: [],
    };
  }
  if (planned.status !== "planned") {
    return planned;
  }

  const { plan } = planned.landing;
  const clean: IntegrationRefusal = {
    status: "lands-cleanly",
    assignmentId: assignment.id,
    branch: row.name,
    tip: row.recordedTip,
    planned: plan.to,
  };
  // A commit that the branch already holds with an equal patch lands nothing and gates nothing.
  if (plan.from === plan.to) {
    return clean;
  }
  return readState(request.projectRoot, (db): IntegrationRead => {
    const verdict = keyStatus(db, candidateKey(planned.landing));
    if (verdict.status !== "failed" && verdict.status !== "flaky") {
      return clean;
    }
    const run = verdict.failed.at(-1);
    if (run === undefined) {
      return clean;
    }
    return {
      status: "evidence",
      submissionId: submission.id,
      integration: {
        ...base,
        cause: verdict.status === "failed" ? "gate-failed" : "gate-flaky",
        paths: [],
        gateRunId: run.id,
      },
      outputs: outputsOf(db, run),
    };
  });
}

/**
 * Plans the rewrite of one correction again (ADR 0020). The correction lands on the parent of the
 * commit it replaces, so a conflict, a changed patch, or a failed or flaky run at its own place
 * names that parent as its tip, and the integration cycle starts there. A later commit that fails
 * is taken out by the rewrite itself, so it needs no cycle of the correction.
 */
async function readRewriteEvidence(request: {
  projectRoot: string;
  assignmentId: string;
  submissionId: string;
  row: IntegrationBranchRow;
  replaced: LandingRow;
  commit: string;
  reviewedBase: string;
}): Promise<IntegrationRead | StateFailure> {
  const { row, replaced } = request;
  const base = {
    branch: row.name,
    tip: replaced.landedParent,
    commit: request.commit,
    replaces: replaced.landedCommit,
  };
  const planned = await planRewrite(request);
  if (planned.status === "landing-conflict" || planned.status === "landing-patch-changed") {
    return {
      status: "evidence",
      submissionId: request.submissionId,
      integration: {
        ...base,
        cause: planned.status === "landing-conflict" ? "conflict" : "patch-changed",
        paths: planned.status === "landing-conflict" ? planned.paths : [],
        gateRunId: null,
      },
      outputs: [],
    };
  }
  if (planned.status !== "planned") {
    return planned;
  }
  return readState(request.projectRoot, (db): IntegrationRead => {
    const gate = rangeGateOf(db, planned.rewrite);
    const run = gate.status === "passed" ? null : readGateRun(db, gate.runIds.at(-1) ?? "");
    if (
      gate.status === "passed" ||
      !gate.correction ||
      (gate.status !== "failed" && gate.status !== "flaky") ||
      run === null
    ) {
      return {
        status: "lands-cleanly",
        assignmentId: request.assignmentId,
        branch: row.name,
        tip: replaced.landedParent,
        planned: planned.rewrite.landing.plan.landed,
      };
    }
    return {
      status: "evidence",
      submissionId: request.submissionId,
      integration: {
        ...base,
        cause: gate.status === "failed" ? "gate-failed" : "gate-flaky",
        paths: [],
        gateRunId: run.id,
      },
      outputs: outputsOf(db, run),
    };
  });
}
