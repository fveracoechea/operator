import { startCandidateGateRun } from "./gate-candidate.ts";
import { startBaseGateRun } from "./gate-start.ts";
import { startRebaseGateRun } from "./rebase.ts";
import { startTakeOutGateRun } from "./take-out.ts";

/**
 * What one gate run start gates (ADR 0021): the candidate of one code result, the integration
 * base of a source at a commit, the next place of a rebase of a source onto a new base, or the
 * next commit of the rebuilt range of the take-out of a source.
 */
export type GateStartSubject =
  | { kind: "candidate"; assignmentId: string }
  | { kind: "base"; sourceId: string; commit: string }
  | { kind: "rebase"; sourceId: string; newBase: string }
  | { kind: "take-out"; sourceId: string };

type StartRequest = {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  approvalId: string | null;
  runnerLine: (runId: string) => string;
};

/** The one start event of the gate run machine. Its subject chooses the target of the run. */
export async function startSubjectGateRun(request: StartRequest & { subject: GateStartSubject }) {
  const { subject, ...shared } = request;
  switch (subject.kind) {
    case "candidate":
      return startCandidateGateRun({ ...shared, assignmentId: subject.assignmentId });
    case "base":
      return startBaseGateRun({ ...shared, sourceId: subject.sourceId, commit: subject.commit });
    case "rebase":
      return startRebaseGateRun({
        ...shared,
        sourceId: subject.sourceId,
        newBase: subject.newBase,
      });
    case "take-out":
      return startTakeOutGateRun({ ...shared, sourceId: subject.sourceId });
  }
}
