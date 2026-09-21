import { afterEach, describe, expect, test } from "bun:test";
import {
  acceptProduction,
  acceptReview,
  commitArtifact,
  delegateRework,
  disposeFindings,
  makeReviewWorkspace,
  type Producer,
  reportBody,
  reportReview,
  startProducer,
  startRework,
  startReviewer,
  submissionBody,
  submit,
  type Workspace,
} from "./review-cycle-fixture.ts";
import { headCommit, herdrCalls, workspaces } from "./workspace-fixture.ts";

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

const BLOCKER = {
  key: "missing-gate",
  severity: "blocker",
  summary: "The result does not state the gate it passed.",
  evidence: "docs/result.md:1",
};

const IMPROVEMENT = {
  key: "wording",
  severity: "improvement",
  summary: "The summary could name the module.",
  evidence: "docs/result.md:3",
};

/** One reviewed result with one blocker and one improvement, ready for a disposition. */
async function reviewedResult(
  workspace: Workspace,
  options: { standards?: typeof BLOCKER[]; spec?: typeof BLOCKER[] } = {},
) {
  const producer = await startProducer(workspace);
  const base = await headCommit(workspace);
  const artifact = await commitArtifact(workspace, producer, "# Result\n");
  const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
  const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
  const reported = await reportReview(
    workspace,
    reviewer,
    submitted.json.data.reviewId,
    reportBody({
      submissionIdentity: submitted.json.data.identity,
      host: workspace.host,
      standardsFindings: options.standards ?? [BLOCKER],
      specFindings: options.spec ?? [IMPROVEMENT],
    }),
  );

  return { producer, base, artifact, submitted, reviewer, reported };
}

type Reported = { json: { data: { findings: Array<{ key: string; findingId: string }> } } };

/** The identity one report gave the finding under this key. */
function findingId(reported: Reported, key: string): string {
  const found = reported.json.data.findings.find((one) => one.key === key);
  if (found === undefined) {
    throw new Error(`the report carries no finding under ${key}`);
  }

  return found.findingId;
}

/** Submits the combined revision of one rework cycle from its own worktree. */
async function submitRevision(
  workspace: Workspace,
  reworked: Producer & { assignmentRevision: number },
  base: string,
  text: string,
) {
  const artifact = await commitArtifact(workspace, reworked, text);
  const submitted = await submit(
    workspace,
    reworked,
    submissionBody(reworked, artifact, base, { assignmentRevision: reworked.assignmentRevision }),
  );
  return { artifact, submitted };
}

describe("operator work rework", () => {
  test("delegates accepted corrections to a fresh Operative and reviews the revision", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const first = await reviewedResult(workspace);
    const { producer, submitted, reviewer } = first;
    const gate = findingId(first.reported, "missing-gate");
    const wording = findingId(first.reported, "wording");

    const undisposed = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: first.artifact.commit,
    });
    expect(undisposed.json.reason).toBe("findings_undisposed");

    await disposeFindings(workspace, producer, submitted.json.data.reviewId, [
      {
        findingId: gate,
        disposition: "corrected",
        reason: "The requirement names the gate, so the result must state it.",
      },
      {
        findingId: wording,
        disposition: "deferred",
        reason: "The wording is readable as it stands.",
        followUp: "github:operator#23",
      },
    ]);

    const pending = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: first.artifact.commit,
    });
    expect(pending.exitCode).toBe(6);
    expect(pending.json.reason).toBe("rework_pending");

    // The reviewer that found it hands its slot back before the correction is delegated.
    await acceptReview(workspace, producer, {
      reviewAssignmentId: submitted.json.data.reviewAssignmentId,
      attemptId: reviewer.attemptId,
      revision: reviewer.revision,
    });

    const delegated = await delegateRework(workspace, producer, {
      revision: submitted.json.data.revision,
      body: {
        reason: "findings",
        reviewId: submitted.json.data.reviewId,
        instruction: "State the gate the result passed, and keep the approved scope.",
        conflicts: [],
      },
    });
    expect(delegated.exitCode).toBe(0);
    expect(delegated.json.reason).toBe("rework_delegated");
    expect(delegated.json.data.cycleIndex).toBe(1);
    expect(delegated.json.data.limit).toBe(3);
    expect(delegated.json.data.corrections).toEqual([gate]);

    const reworked = await startRework(workspace, producer, {
      revision: delegated.json.data.revision,
      commit: first.artifact.commit,
      worktreePath: `${workspace.root}/rework`,
    });

    // The rework runs as its own Herdr agent, never the reviewer's and never the Operator.
    const agents = (await herdrCalls(workspace))
      .filter((line) => line.startsWith("agent start "))
      .map((line) => line.split(" ")[2]);
    expect(new Set(agents).size).toBe(agents.length);

    const brief = await Bun.file(`${reworked.worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain("## The result you rework");
    expect(brief).toContain("findings cycle 1 of 3");
    expect(brief).toContain(gate);
    expect(brief).toContain("State the gate the result passed");
    expect(brief).toContain("The Operator accepted it because:");
    // The deferred finding was answered already, so it is not delegated work.
    expect(brief).not.toContain("The summary could name the module.");
    expect(brief).toContain("The acceptance requirements above still stand.");
    // The original requirements reach the rework unchanged.
    expect(brief).toContain("- The quality gate passes.");

    const copied = await Bun.file(
      `${reworked.worktreePath}/.operator/local/rework/0-result.md`,
    ).text();
    expect(copied).toBe("# Result\n");

    const second = await submitRevision(
      workspace,
      reworked,
      first.base,
      "# Result\n\nThe quality gate passed.\n",
    );
    expect(second.submitted.json.data.reworkCycleId).toBe(delegated.json.data.cycleId);
    // A second round is a separate review assignment, so a separate reviewer takes it.
    expect(second.submitted.json.data.reviewAssignmentId).not.toBe(
      submitted.json.data.reviewAssignmentId,
    );

    const secondReviewer = await startReviewer(
      workspace,
      producer,
      second.submitted.json,
      second.artifact.commit,
    );
    const secondBrief = await Bun.file(
      `${secondReviewer.worktreePath}/.operator/local/brief.md`,
    ).text();
    expect(secondBrief).toContain("### Earlier rounds on this assignment");
    expect(secondBrief).toContain(`${gate} (standards, blocker) corrected`);
    expect(secondBrief).toContain(`${wording} (spec, improvement) deferred`);
    expect(secondBrief).toContain("Rework cycle");
    expect(secondBrief).toContain("report a finding that");

    const secondReport = await reportReview(
      workspace,
      secondReviewer,
      second.submitted.json.data.reviewId,
      reportBody({
        submissionIdentity: second.submitted.json.data.identity,
        host: workspace.host,
      }),
    );
    expect(secondReport.json.reason).toBe("review_reported");

    const accepted = await acceptProduction(workspace, reworked, {
      submissionId: second.submitted.json.data.submissionId,
      revision: second.submitted.json.data.revision,
      prHead: second.artifact.commit,
    });
    expect(accepted.exitCode).toBe(0);
    expect(accepted.json.reason).toBe("assignment_accepted");
  });
});
