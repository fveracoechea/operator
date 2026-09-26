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
import { headCommit, requestId as request, runJson, workspaces } from "./workspace-fixture.ts";

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

describe("operator work accept", () => {
  test("refuses acceptance while the review reports nothing", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));

    // The reviewer process exits with nothing recorded, which is not a review.
    await startReviewer(workspace, producer, submitted.json, artifact.commit);

    const accepted = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: artifact.commit,
    });

    expect(accepted.exitCode).toBe(3);
    expect(accepted.json.reason).toBe("review_incomplete");
    expect(accepted.json.blockers[0].state).toBe("registered");
  });

  test("refuses acceptance when the review host cannot run the axes", async () => {
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
        reason: "review_capability_unavailable",
        detail: "This host cannot start two parallel sub-agents.",
      },
    });
    expect(blocked.exitCode).toBe(3);
    expect(blocked.json.reason).toBe("review_blocked");

    const accepted = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: artifact.commit,
    });
    expect(accepted.exitCode).toBe(3);
    expect(accepted.json.reason).toBe("review_incomplete");
    expect(accepted.json.blockers[0].blocker.reason).toBe("review_capability_unavailable");

    // A blocked review never reaches accepted completion either.
    const reviewAccepted = await runJson(workspace, [
      "work",
      "accept",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--assignment",
      submitted.json.data.reviewAssignmentId,
      "--attempt",
      reviewer.attemptId,
      "--revision",
      String(reviewer.revision),
    ]);
    expect(reviewAccepted.exitCode).toBe(3);
    expect(reviewAccepted.json.reason).toBe("review_incomplete");
  });

  test("refuses acceptance when a review observed a check the producer called passed", async () => {
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
        observedChecks: [{ name: "quality", outcome: "failed" }],
      }),
    );
    expect(reported.json.reason).toBe("review_reported");

    const accepted = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: artifact.commit,
    });

    expect(accepted.json.reason).toBe("checks_contradicted");
    expect(accepted.exitCode).toBe(4);
    expect(accepted.json.blockers[0]).toMatchObject({
      name: "quality",
      recorded: "passed",
      observed: "failed",
      axis: "standards",
    });
  });

  test("accepts when the review observed the same outcomes the producer recorded", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
    await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({
        submissionIdentity: submitted.json.data.identity,
        host: workspace.host,
        observedChecks: [{ name: "quality", outcome: "passed" }],
      }),
    );

    const accepted = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: artifact.commit,
    });

    expect(accepted.json.reason).toBe("assignment_accepted");
    expect(accepted.exitCode).toBe(0);
  });

  test("refuses acceptance while a check did not pass", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, base, {
        checks: [
          { name: "quality", command: "bun run quality", outcome: "passed", detail: "" },
          { name: "integration", command: "bun test", outcome: "flaky", detail: "One rerun." },
        ],
      }),
    );
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
    await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
    );

    const accepted = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: artifact.commit,
    });

    expect(accepted.exitCode).toBe(3);
    expect(accepted.json.reason).toBe("checks_unproven");
    expect(accepted.json.blockers[0]).toMatchObject({ name: "integration", outcome: "flaky" });
  });

  test("refuses acceptance when the pull request head moved after the review", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
    await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
    );

    const missing = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
    });
    expect(missing.exitCode).toBe(3);
    expect(missing.json.reason).toBe("pr_head_required");

    const moved = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: "0".repeat(40),
    });
    expect(moved.exitCode).toBe(4);
    expect(moved.json.reason).toBe("pr_head_changed");
  });

  test("refuses acceptance when the implementation carries no pull request authority", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, base, {
        pullRequest: { status: "authority-missing", detail: "No push approval was given." },
      }),
    );
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
    await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
    );

    const accepted = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
    });

    expect(accepted.exitCode).toBe(3);
    expect(accepted.json.reason).toBe("pr_authority_missing");
  });

  test("holds acceptance while an accepted correction waits for a fresh Operative", async () => {
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
        standardsFindings: [
          {
            key: "missing-comment",
            severity: "blocker",
            summary: "The transition states no reason.",
            evidence: "modules/crew-state/acceptance.ts",
          },
        ],
      }),
    );
    const findingId = reported.json.data.findings[0].findingId;

    const deferred = await runJson(workspace, [
      "review",
      "dispose",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--review",
      submitted.json.data.reviewId,
      "--input",
      await writeInput(workspace, {
        dispositions: [
          { findingId, disposition: "deferred", reason: "Later.", followUp: "github:operator#23" },
        ],
      }),
    ]);
    expect(deferred.exitCode).toBe(2);
    expect(deferred.json.reason).toBe("blocker_not_deferrable");

    const corrected = await runJson(workspace, [
      "review",
      "dispose",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--review",
      submitted.json.data.reviewId,
      "--input",
      await writeInput(workspace, {
        dispositions: [{ findingId, disposition: "corrected", reason: "The comment is required." }],
      }),
    ]);
    expect(corrected.exitCode).toBe(6);
    expect(corrected.json.data.corrections).toEqual([findingId]);

    const accepted = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: artifact.commit,
    });
    expect(accepted.exitCode).toBe(6);
    expect(accepted.json.reason).toBe("rework_pending");
  });
});

describe("operator work frontier", () => {
  test("a one-agent crew hands its only slot from the producer to the reviewer", async () => {
    const workspace = await makeWorkspace({ maxActiveAgents: 1 });
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const busy = await runJson(workspace, ["work", "frontier"]);
    expect(busy.json.data.capacity.active.total).toBe(1);
    expect(busy.json.data.capacity.freeSlots).toBe(0);

    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const free = await runJson(workspace, ["work", "frontier"]);
    expect(free.json.data.capacity.active.total).toBe(0);
    expect(
      free.json.data.dispatchable.map((one: { assignmentId: string }) => one.assignmentId),
    ).toEqual([submitted.json.data.reviewAssignmentId]);

    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
    const held = await runJson(workspace, ["work", "frontier"]);
    expect(held.json.data.capacity.active).toMatchObject({ total: 1, review: 1, production: 0 });
    expect(reviewer.dispatched.json.reason).toBe("acknowledgement_pending");
  });
});
