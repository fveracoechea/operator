import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acceptAssignment,
  acceptProduction,
  acceptReview,
  commitArtifact,
  frontierEntry,
  invalidateResult,
  makeReviewWorkspace,
  PLANNING_RECORD,
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
import { nextActions, requestId as request, runJson, workspaces } from "./workspace-fixture.ts";

// Invalidation tests run complete review cycles through separate CLI processes.
setDefaultTimeout(60_000);

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
async function acceptedResult(workspace: Workspace, producer: Producer, text: string) {
  const artifact = await commitArtifact(workspace, producer, text);
  const submitted = await submit(
    workspace,
    producer,
    submissionBody(producer, artifact, { assignmentRevision: producer.assignmentRevision }),
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
    const first = await acceptedResult(workspace, producer, "# Result\n");
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
    const second = await acceptedResult(workspace, fixing, "# Result\n\nEvery record.\n");
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
    const first = await acceptedResult(workspace, producer, "# First\n");

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
    const otherResult = await acceptedResult(workspace, second, "# Other\n");
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
    await acceptedResult(workspace, firstFix, "# First, corrected\n");

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
    await acceptedResult(workspace, secondFix, "# Other, corrected\n");

    const released = await frontierEntry(workspace, consumer);
    expect(released.entry.state).toBe("registered");
    const again = await acceptAssignment(workspace, producer, {
      assignmentId: consumer,
      revision: released.entry.revision,
    });
    expect(again.json.reason).toBe("assignment_accepted");
  }, 120_000);

  test("an invalidated planning decision is accepted again and releases its dependents", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const first = await acceptedResult(workspace, producer, "# Result\n");
    expect(first.accepted.json.reason).toBe("assignment_accepted");

    const registered = await registerDependents(workspace, producer, [
      { key: "22.2", kind: "planning", title: "Decide the rollout order" },
      { key: "22.3", kind: "production", title: "Roll out", dependsOn: ["22.2"] },
    ]);
    const planning = registered.get("22.2") ?? "";
    const dependent = registered.get("22.3") ?? "";

    const decided = await acceptAssignment(workspace, producer, {
      assignmentId: planning,
      revision: 1,
    });
    expect(decided.json.reason).toBe("assignment_accepted");

    await startRework(workspace, producer, {
      revision: 1,
      commit: first.artifact.commit,
      worktreePath: `${workspace.root}/rollout`,
      assignmentId: dependent,
    });

    const invalidated = await invalidateResult(workspace, producer, {
      assignmentId: planning,
      revision: decided.json.data.revision,
      defect: DEFECT,
    });
    expect(invalidated.json.reason).toBe("result_invalidated");
    expect(invalidated.json.data.dependents).toEqual([
      { assignmentId: dependent, title: "Roll out", consumedState: "claimed", paused: true },
    ]);

    const held = await frontierEntry(workspace, dependent);
    expect(held.group).toBe("blocked");
    expect(held.entry.state).toBe("paused");
    expect(held.entry.blockers[0]).toEqual({
      reason: "input_invalidated",
      invalidated: [planning],
    });

    // The changed decision is the fix, so the Operator resolves the planning work again.
    const next = await nextActions(workspace);
    const resolve = next.forAction("resolve_planning").find((one) => one.assignmentId === planning);
    expect(resolve?.revision).toBe(invalidated.json.data.revision);
    expect(resolve?.detail).toContain("invalidated");

    // The record gate covers the decision taken again, so a bare acceptance still refuses.
    const bare = await runJson(workspace, [
      "work",
      "accept",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--assignment",
      planning,
      "--revision",
      String(invalidated.json.data.revision),
    ]);
    expect(bare.json.reason).toBe("planning_record_required");
    expect((await frontierEntry(workspace, dependent)).entry.state).toBe("paused");

    const again = await acceptAssignment(workspace, producer, {
      assignmentId: planning,
      revision: invalidated.json.data.revision,
      record: {
        ...PLANNING_RECORD,
        entries: [{ ...PLANNING_RECORD.entries[0], exactText: "Roll out the other order." }],
      },
    });
    expect(again.exitCode).toBe(0);
    expect(again.json.reason).toBe("assignment_accepted");
    // The changed decision is a new record. The first one stays as it was accepted.
    expect(again.json.data.planningRecordId).toEqual(expect.any(String));
    expect(again.json.data.planningRecordId).not.toBe(decided.json.data.planningRecordId);
    const latest = await runJson(workspace, ["work", "record", "--assignment", planning]);
    expect(latest.json.data.record.recordId).toBe(again.json.data.planningRecordId);
    expect(latest.json.data.record.entries[0].exactText).toBe("Roll out the other order.");
    expect(latest.json.data.recordIds).toEqual([
      decided.json.data.planningRecordId,
      again.json.data.planningRecordId,
    ]);
    const earlier = await runJson(workspace, [
      "work",
      "record",
      "--assignment",
      planning,
      "--record",
      decided.json.data.planningRecordId,
    ]);
    expect(earlier.json.data.record.entries[0].exactText).toBe("Yes.");

    const resumed = await frontierEntry(workspace, dependent);
    expect(resumed.group).toBe("active");
    expect(resumed.entry.state).toBe("claimed");
    expect(resumed.entry.blockers ?? []).toEqual([]);
  }, 60_000);

  test("an invalidated assignment holds its write paths again until it is accepted again", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const first = await acceptedResult(workspace, producer, "# Result\n");

    const registered = await registerDependents(workspace, producer, [
      {
        key: "22.4",
        kind: "production",
        title: "Change a file the result also changed",
        dependsOn: [],
        writePaths: ["docs/result.md"],
      },
    ]);
    const overlapping = registered.get("22.4") ?? "";

    // Accepted work holds nothing, so the overlapping work is offered.
    expect((await frontierEntry(workspace, overlapping)).group).toBe("dispatchable");

    const invalidated = await invalidateResult(workspace, producer, {
      assignmentId: producer.assignmentId,
      revision: first.accepted.json.data.revision,
      defect: DEFECT,
    });
    expect(invalidated.json.reason).toBe("result_invalidated");

    const held = await frontierEntry(workspace, overlapping);
    expect(held.group).toBe("blocked");
    expect(held.entry.blockers).toEqual([
      {
        reason: "write_paths_overlap",
        holders: [
          {
            assignmentId: producer.assignmentId,
            sourceKey: "22.1",
            hold: "started",
            pathPairCount: 1,
          },
        ],
        command: "operator work overlaps --source github:operator#15",
      },
    ]);

    const fixing = await startRework(workspace, producer, {
      revision: invalidated.json.data.revision,
      commit: first.artifact.commit,
      worktreePath: `${workspace.root}/fix`,
    });
    // The correction is in progress, so the paths stay held.
    expect((await frontierEntry(workspace, overlapping)).group).toBe("blocked");

    const second = await acceptedResult(workspace, fixing, "# Result\n\nEvery record.\n");
    expect(second.accepted.json.reason).toBe("assignment_accepted");

    expect((await frontierEntry(workspace, overlapping)).group).toBe("dispatchable");
  }, 60_000);

  test("offers an invalidated assignment again past started work that overlaps it", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const first = await acceptedResult(workspace, producer, "# Result\n");

    const registered = await registerDependents(workspace, producer, [
      {
        key: "22.4",
        kind: "production",
        title: "Change a file the result also changed",
        dependsOn: [],
        writePaths: ["docs/result.md"],
      },
    ]);
    const overlapping = registered.get("22.4") ?? "";
    const claimed = await runJson(workspace, [
      "work",
      "claim",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--assignment",
      overlapping,
      "--revision",
      "1",
    ]);
    expect(claimed.json.reason).toBe("assignment_claimed");

    await invalidateResult(workspace, producer, {
      assignmentId: producer.assignmentId,
      revision: first.accepted.json.data.revision,
      defect: DEFECT,
    });

    // Both started from their own bases, so withholding one of them prevents no changed patch,
    // and two started assignments that withheld each other would wait for ever.
    const reopened = await frontierEntry(workspace, producer.assignmentId);
    expect(reopened.group).toBe("dispatchable");
    expect((await frontierEntry(workspace, overlapping)).group).toBe("active");
  }, 60_000);

  test("refuses a defect against a review, which holds no result of its own", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact));
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
