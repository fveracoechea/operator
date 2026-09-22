import { afterEach, describe, expect, test } from "bun:test";
import {
  acceptAssignment,
  acceptProduction,
  acceptReview,
  commitArtifact,
  frontierEntry,
  invalidateResult,
  makeReviewWorkspace,
  type Producer,
  registerDependents,
  reportBody,
  reportReview,
  startProducer,
  startRework,
  startReviewer,
  submissionBody,
  submit,
  type Workspace,
} from "./review-cycle-fixture.ts";
import { headCommit, requestId as request, runJson, workspaces } from "./workspace-fixture.ts";

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

const DEFECT = {
  summary: "The accepted result drops every second record.",
  evidence: "modules/crew-state/frontier.ts:150 and the failing rerun of bun test.",
  foundBy: "the Operative on 22.3",
};

/** Produces, reviews, and accepts one result, which is what a defect is later found in. */
async function acceptedResult(
  workspace: Workspace,
  producer: Producer,
  base: string,
  text: string,
) {
  const artifact = await commitArtifact(workspace, producer, text);
  const submitted = await submit(
    workspace,
    producer,
    submissionBody(producer, artifact, base, { assignmentRevision: producer.assignmentRevision }),
  );
  const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
  await reportReview(
    workspace,
    reviewer,
    submitted.json.data.reviewId,
    reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
  );
  // The reviewer hands its crew slot back, so the next round of this fixture can launch.
  await acceptReview(workspace, producer, {
    reviewAssignmentId: submitted.json.data.reviewAssignmentId,
    attemptId: reviewer.attemptId,
    revision: reviewer.revision,
  });
  const accepted = await acceptProduction(workspace, producer, {
    submissionId: submitted.json.data.submissionId,
    revision: submitted.json.data.revision,
    prHead: artifact.commit,
  });

  return { artifact, submitted, reviewer, accepted };
}

describe("operator work invalidate", () => {
  test("pauses only the work that read the invalid result and keeps the history", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const first = await acceptedResult(workspace, producer, base, "# Result\n");
    expect(first.accepted.json.reason).toBe("assignment_accepted");

    const dependents = await registerDependents(workspace, producer, [
      { key: "22.2", kind: "planning", title: "Decide the rollout order" },
      { key: "22.3", kind: "production", title: "Build on the accepted result" },
    ]);
    const consumer = dependents.get("22.2") ?? "";
    const unstarted = dependents.get("22.3") ?? "";

    const resolved = await acceptAssignment(workspace, producer, {
      assignmentId: consumer,
      revision: 1,
    });
    expect(resolved.json.reason).toBe("assignment_accepted");

    const invalidated = await invalidateResult(workspace, producer, {
      assignmentId: producer.assignmentId,
      revision: first.accepted.json.data.revision,
      defect: DEFECT,
    });
    expect(invalidated.exitCode).toBe(0);
    expect(invalidated.json.reason).toBe("result_invalidated");
    expect(invalidated.json.data.submissionId).toBe(first.submitted.json.data.submissionId);
    // Only the dependent that read the result is paused. The one that never started is not.
    expect(invalidated.json.data.dependents).toEqual([
      {
        assignmentId: consumer,
        title: "Decide the rollout order",
        consumedState: "accepted",
        paused: true,
      },
    ]);

    // The acceptance, its submission, and its review stay exactly as they were recorded.
    const shown = await runJson(workspace, [
      "review",
      "show",
      "--review",
      first.submitted.json.data.reviewId,
    ]);
    expect(shown.json.data.review.state).toBe("reported");
    expect(shown.json.data.submission.state).toBe("accepted");

    const paused = await frontierEntry(workspace, consumer);
    expect(paused.group).toBe("blocked");
    expect(paused.entry.state).toBe("paused");
    expect(paused.entry.blockers[0]).toEqual({
      reason: "input_invalidated",
      invalidated: [producer.assignmentId],
    });

    // Work that never started is held by the dependency gate, exactly as before.
    const waiting = await frontierEntry(workspace, unstarted);
    expect(waiting.group).toBe("blocked");
    expect(waiting.entry.state).toBe("registered");
    expect(waiting.entry.blockers[0].reason).toBe("dependency_pending");

    const refused = await acceptAssignment(workspace, producer, {
      assignmentId: consumer,
      revision: paused.entry.revision,
    });
    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("input_invalidated");

    // The defective work returns to the frontier, because the fix is work on that assignment.
    const reopened = await frontierEntry(workspace, producer.assignmentId);
    expect(reopened.group).toBe("dispatchable");
    expect(reopened.entry.state).toBe("invalidated");

    const fixing = await startRework(workspace, producer, {
      revision: invalidated.json.data.revision,
      commit: first.artifact.commit,
      worktreePath: `${workspace.root}/fix`,
    });
    const second = await acceptedResult(workspace, fixing, base, "# Result\n\nEvery record.\n");
    expect(second.accepted.json.reason).toBe("assignment_accepted");

    // The corrected result is what the paused dependent waited on, so its decision comes back.
    const released = await frontierEntry(workspace, consumer);
    expect(released.entry.state).toBe("registered");
    const again = await acceptAssignment(workspace, producer, {
      assignmentId: consumer,
      revision: released.entry.revision,
    });
    expect(again.json.reason).toBe("assignment_accepted");
  }, 60_000);

  test("a dependent of two invalid results waits for both corrections", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const first = await acceptedResult(workspace, producer, base, "# First\n");

    const registered = await registerDependents(workspace, producer, [
      { key: "22.4", kind: "production", title: "The other input", dependsOn: [] },
      {
        key: "22.5",
        kind: "planning",
        title: "Decide from both inputs",
        dependsOn: ["22.1", "22.4"],
      },
    ]);
    const other = registered.get("22.4") ?? "";
    const consumer = registered.get("22.5") ?? "";

    // The second input is produced, reviewed, and accepted on its own assignment.
    const second = await startRework(workspace, producer, {
      revision: 1,
      commit: first.artifact.commit,
      worktreePath: `${workspace.root}/other`,
      assignmentId: other,
    });
    const otherResult = await acceptedResult(workspace, second, base, "# Other\n");
    expect(otherResult.accepted.json.reason).toBe("assignment_accepted");

    const resolved = await acceptAssignment(workspace, producer, {
      assignmentId: consumer,
      revision: 1,
    });
    expect(resolved.json.reason).toBe("assignment_accepted");

    const firstDefect = await invalidateResult(workspace, producer, {
      assignmentId: producer.assignmentId,
      revision: first.accepted.json.data.revision,
      defect: DEFECT,
    });
    expect(firstDefect.json.data.dependents[0].consumedState).toBe("accepted");

    const secondDefect = await invalidateResult(workspace, producer, {
      assignmentId: other,
      revision: otherResult.accepted.json.data.revision,
      defect: DEFECT,
    });
    // The dependent is already paused, and what it must return to is where it was before that.
    expect(secondDefect.json.data.dependents).toEqual([
      {
        assignmentId: consumer,
        title: "Decide from both inputs",
        consumedState: "accepted",
        paused: true,
      },
    ]);

    // Correcting the first input alone does not release work that also read the second.
    const firstFix = await startRework(workspace, producer, {
      revision: firstDefect.json.data.revision,
      commit: first.artifact.commit,
      worktreePath: `${workspace.root}/fix-first`,
    });
    await acceptedResult(workspace, firstFix, base, "# First, corrected\n");

    const held = await frontierEntry(workspace, consumer);
    expect(held.entry.state).toBe("paused");
    expect(held.entry.blockers[0]).toEqual({
      reason: "input_invalidated",
      invalidated: [other],
    });

    const refused = await acceptAssignment(workspace, producer, {
      assignmentId: consumer,
      revision: held.entry.revision,
    });
    expect(refused.json.reason).toBe("input_invalidated");

    // Only the second correction releases it, and it returns to the step that decided it.
    const secondFix = await startRework(workspace, producer, {
      revision: secondDefect.json.data.revision,
      commit: otherResult.artifact.commit,
      worktreePath: `${workspace.root}/fix-other`,
      assignmentId: other,
    });
    await acceptedResult(workspace, secondFix, base, "# Other, corrected\n");

    const released = await frontierEntry(workspace, consumer);
    expect(released.entry.state).toBe("registered");
    const again = await acceptAssignment(workspace, producer, {
      assignmentId: consumer,
      revision: released.entry.revision,
    });
    expect(again.json.reason).toBe("assignment_accepted");
  }, 120_000);

  test("refuses a defect against a review, which holds no result of its own", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
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
    const accepted = await runJson(workspace, [
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
    expect(accepted.json.reason).toBe("assignment_accepted");

    const refused = await invalidateResult(workspace, producer, {
      assignmentId: submitted.json.data.reviewAssignmentId,
      revision: accepted.json.data.revision,
      defect: DEFECT,
    });

    expect(refused.exitCode).toBe(2);
    expect(refused.json.reason).toBe("review_not_invalidated");
  });

  test("refuses a defect against work that holds no accepted result", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);

    const refused = await invalidateResult(workspace, producer, {
      assignmentId: producer.assignmentId,
      revision: producer.assignmentRevision,
      defect: DEFECT,
    });

    expect(refused.exitCode).toBe(4);
    expect(refused.json.reason).toBe("assignment_not_accepted");
    expect(refused.json.blockers[0]).toMatchObject({ state: "claimed" });
  });
});
