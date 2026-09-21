import { afterEach, describe, expect, test } from "bun:test";
import {
  acceptProduction,
  commitArtifact,
  makeReviewWorkspace,
  reportBody,
  reportReview,
  startProducer,
  startReviewer,
  submissionBody,
  submit,
  writeInput,
} from "./review-cycle-fixture.ts";
import { ContentIdentity } from "../content-identity/main.ts";
import {
  headCommit,
  herdrCalls,
  requestId as request,
  runJson,
  workspaces,
} from "./workspace-fixture.ts";

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

async function makeWorkspace(
  options: {
    host?: "claude-code" | "opencode";
    maxActiveAgents?: number;
    reviewSkill?: boolean;
  } = {},
) {
  return makeReviewWorkspace(fixtures, options);
}

describe("operator review report", () => {
  test("reviews a code result on both axes and then accepts it", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n\nThe finished work.\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewId = submitted.json.data.reviewId;

    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
    expect(reviewer.dispatched.json.reason).toBe("acknowledgement_pending");

    // The reviewer holds one Herdr slot, and its axes are native sub-agents of its own host.
    expect(
      (await herdrCalls(workspace)).filter((line) => line.startsWith("agent start ")),
    ).toHaveLength(2);

    const brief = await Bun.file(`${reviewer.worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain("Load the `code-review` skill");
    expect(brief).toContain(submitted.json.data.identity);
    expect(brief).toContain("standards and spec");
    expect(brief).toContain("Never start a Herdr agent");
    expect(brief).toContain("They must never edit a file, commit, push, or perform rework.");
    // The reviewer writes its own report and nothing else, so rework cannot hide inside a review.
    expect(brief).toContain("Write only inside these paths:\n- .operator/local/");
    // The brief authorizes the commands the reviewer must run, not only the checks it may re-run.
    expect(brief).toContain(
      "Run only these commands:\n- operator attempt acknowledge\n- operator review report\n- bun run quality",
    );

    const copied = await Bun.file(
      `${reviewer.worktreePath}/.operator/local/review/0-result.md`,
    ).text();
    expect(copied).toBe("# Result\n\nThe finished work.\n");

    const reported = await reportReview(
      workspace,
      reviewer,
      reviewId,
      reportBody({
        submissionIdentity: submitted.json.data.identity,
        host: workspace.host,
        specFindings: [
          {
            key: "coverage-rule",
            severity: "improvement",
            summary: "The coverage tokens could be documented.",
            evidence: "docs/result.md",
          },
        ],
      }),
    );
    expect(reported.exitCode).toBe(0);
    expect(reported.json.reason).toBe("review_reported");
    expect(reported.json.data.findings).toHaveLength(1);

    const findingId = reported.json.data.findings[0].findingId;
    const blockedByFinding = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: artifact.commit,
    });
    expect(blockedByFinding.exitCode).toBe(3);
    expect(blockedByFinding.json.reason).toBe("findings_undisposed");

    const disposed = await runJson(workspace, [
      "review",
      "dispose",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--review",
      reviewId,
      "--input",
      await writeInput(workspace, {
        dispositions: [
          {
            findingId,
            disposition: "deferred",
            reason: "The coverage rule is documented in the ADR instead.",
            followUp: "github:operator#23",
          },
        ],
      }),
    ]);
    expect(disposed.exitCode).toBe(0);
    expect(disposed.json.data.outstanding).toEqual([]);

    const accepted = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: artifact.commit,
    });
    expect(accepted.exitCode).toBe(0);
    expect(accepted.json.reason).toBe("assignment_accepted");

    const shown = await runJson(workspace, ["review", "show", "--review", reviewId]);
    expect(shown.json.data.review.state).toBe("reported");
    expect(shown.json.data.reports.map((one: { axis: string }) => one.axis)).toEqual([
      "spec",
      "standards",
    ]);
    expect(shown.json.data.submission.state).toBe("accepted");
  });

  test("reviews a non-code result against citations and provenance on opencode", async () => {
    const workspace = await makeWorkspace({ host: "opencode" });
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Findings\n\nOne citation.\n");
    const submitted = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, base, {
        resultKind: "non-code",
        checks: [],
        code: null,
      }),
    );
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    const brief = await Bun.file(`${reviewer.worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain("This result is not code.");
    expect(brief).toContain("supported by a citation you can follow");
    expect(brief).toContain("artifacts, requirements, citations, provenance");
    // A non-code result records no check, and the reviewer can still report what it read.
    expect(brief).toContain(
      "Run only these commands:\n- operator attempt acknowledge\n- operator review report\n",
    );

    const codeCoverage = await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({
        submissionIdentity: submitted.json.data.identity,
        host: "opencode",
        checked: ["diff", "requirements", "checks"],
      }),
    );
    expect(codeCoverage.exitCode).toBe(3);
    expect(codeCoverage.json.reason).toBe("review_coverage_incomplete");
    expect(codeCoverage.json.blockers[0].missing).toEqual(["artifacts", "citations", "provenance"]);

    const reported = await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({
        submissionIdentity: submitted.json.data.identity,
        host: "opencode",
        checked: ["artifacts", "requirements", "citations", "provenance"],
      }),
    );
    expect(reported.exitCode).toBe(0);
    expect(reported.json.reason).toBe("review_reported");

    const shown = await runJson(workspace, [
      "review",
      "show",
      "--review",
      submitted.json.data.reviewId,
    ]);
    expect(shown.json.data.review.host).toBe("opencode");
    expect(shown.json.data.review.subAgents.map((one: { host: string }) => one.host)).toEqual([
      "opencode",
      "opencode",
    ]);

    // A non-code result carries no pull request, so acceptance needs no head.
    const accepted = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
    });
    expect(accepted.exitCode).toBe(0);
    expect(accepted.json.reason).toBe("assignment_accepted");
  });

  test("refuses a report from a worktree the reviewer changed", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    // A reviewer may read and run checks. Repairing what it found is rework, and rework is a
    // separate assignment that a fresh Operative receives.
    await Bun.write(`${reviewer.worktreePath}/${artifact.path}`, "# Repaired by the reviewer\n");

    const reported = await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
    );

    expect(reported.json.reason).toBe("review_worktree_changed");
    expect(reported.exitCode).toBe(4);
    expect(reported.json.blockers[0]).toMatchObject({ path: artifact.path });
  });

  test("refuses a report from a worktree the reviewer committed to", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    await Bun.write(`${reviewer.worktreePath}/${artifact.path}`, "# Repaired by the reviewer\n");
    await Bun.$`git -C ${reviewer.worktreePath} add ${artifact.path}`.quiet();
    await Bun.$`git -C ${reviewer.worktreePath} -c user.email=t@example.com -c user.name=Test commit -m rework`.quiet();

    const reported = await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
    );

    expect(reported.json.reason).toBe("review_worktree_changed");
    expect(
      reported.json.blockers.some((one: { commit?: string }) => one.commit !== undefined),
    ).toBe(true);
  });

  test("refuses a report that names a host the launch did not use", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    const reported = await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      // The sub-agents name the launched host, so only the stated host can be refused here.
      reportBody({
        submissionIdentity: submitted.json.data.identity,
        host: workspace.host,
        statedHost: "opencode",
      }),
    );

    expect(reported.json.reason).toBe("review_host_mismatch");
    expect(reported.exitCode).toBe(4);
    expect(reported.json.blockers[0]).toMatchObject({ host: "opencode", recorded: "claude-code" });
  });

  test("records a missing review input as a blocker, not as a verdict", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    const blocked = await reportReview(workspace, reviewer, submitted.json.data.reviewId, {
      kind: "blocked",
      submissionIdentity: submitted.json.data.identity,
      host: workspace.host,
      blocker: {
        reason: "inputs_missing",
        detail: "The spec the assignment names is not readable.",
      },
    });
    expect(blocked.json.reason).toBe("review_blocked");
    expect(blocked.exitCode).toBe(3);

    const shown = await runJson(workspace, [
      "review",
      "show",
      "--review",
      submitted.json.data.reviewId,
    ]);
    expect(shown.json.data.review.state).toBe("blocked");
    expect(shown.json.data.review.blocker.reason).toBe("inputs_missing");

    const accepted = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: artifact.commit,
    });
    expect(accepted.json.reason).toBe("review_incomplete");
    expect(accepted.json.blockers[0].blocker.reason).toBe("inputs_missing");
  });

  test("refuses two axes that ran one after the other", async () => {
    const workspace = await makeWorkspace();
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
        sequential: true,
      }),
    );

    expect(reported.exitCode).toBe(4);
    expect(reported.json.reason).toBe("review_axes_not_parallel");
  });

  test("refuses a sub-agent that did not run inside the reviewer host", async () => {
    const workspace = await makeWorkspace();
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
        subAgentHost: "opencode",
      }),
    );

    expect(reported.exitCode).toBe(4);
    expect(reported.json.reason).toBe("review_sub_agent_host_mismatch");
  });

  test("refuses a report that names a different submission than the one under review", async () => {
    const workspace = await makeWorkspace();
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
        submissionIdentity: ContentIdentity.ofText("another result"),
        host: workspace.host,
      }),
    );

    expect(reported.exitCode).toBe(4);
    expect(reported.json.reason).toBe("submission_drift");
  });

  test("a review report is never a submitted result, so it starts no second review", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    const attempted = await runJson(
      workspace,
      [
        "attempt",
        "submit",
        "--request",
        request(),
        "--attempt",
        reviewer.attemptId,
        "--input",
        await writeInput(
          workspace,
          submissionBody(producer, artifact, base, { resultKind: "non-code" }),
        ),
      ],
      reviewer.worktreePath,
    );

    expect(attempted.exitCode).toBe(2);
    expect(attempted.json.reason).toBe("review_result_not_submitted");
  });
});
