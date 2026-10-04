import { issueKey } from "./source-fixture.ts";
import { afterEach, describe, expect, test as bunTest } from "bun:test";
import {
  acceptAssignment,
  acceptProduction,
  acceptReview,
  commitArtifact,
  frontierEntry,
  grantDirection,
  invalidateResult,
  makeReviewWorkspace,
  PLANNING_RECORD,
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
import { nextActions, requestId as request, runJson, workspaces } from "./workspace-fixture.ts";

// Invalidation tests run complete review cycles through separate CLI processes.
// Each test states its own bound, because a process-wide default would set the bound of every
// file in the bun test process (#179).
function test(name: string, run: () => Promise<void> | void, timeoutMs = 60_000) {
  bunTest(name, run, timeoutMs);
}

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
  text: string,
  path = "docs/result.md",
) {
  const artifact = await commitArtifact(workspace, producer, text, path);
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
  });

  return { artifact, submitted, reviewer, accepted };
}

/** Launches one claimed attempt as the CLI does, with no `--commit` when none is named. */
async function dispatchAt(
  workspace: Workspace,
  producer: Producer,
  options: { attemptId: string; commit: string | null; worktreePath: string },
) {
  return runJson(workspace, [
    "attempt",
    "dispatch",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--attempt",
    options.attemptId,
    ...(options.commit === null ? [] : ["--commit", options.commit]),
    "--worktree",
    options.worktreePath,
  ]);
}

async function claim(workspace: Workspace, producer: Producer, revision: number) {
  return runJson(workspace, [
    "work",
    "claim",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--assignment",
    producer.assignmentId,
    "--revision",
    String(revision),
  ]);
}

describe("operator work invalidate", () => {
  test("opens the cycle that carries the defect, the accepted submission, and the landed commit", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const first = await acceptedResult(workspace, producer, "# Result\n");
    const landed = first.artifact.commit;

    const invalidated = await invalidateResult(workspace, producer, {
      assignmentId: producer.assignmentId,
      revision: first.accepted.json.data.revision,
      defect: DEFECT,
    });
    expect(invalidated.json.reason).toBe("result_invalidated");
    expect(invalidated.json.data.cycle).toMatchObject({
      cycleIndex: 1,
      limit: 3,
      landedCommit: landed,
      startCommit: landed,
    });
    expect(invalidated.json.data.direction).toBeNull();

    const claimed = await claim(workspace, producer, invalidated.json.data.revision);
    expect(claimed.json.reason).toBe("assignment_claimed");
    const attemptId = claimed.json.data.attemptId;

    // The correction starts at the landed commit, and its acceptance puts it in that place.
    const onParent = await dispatchAt(workspace, producer, {
      attemptId,
      commit: producer.baseCommit,
      worktreePath: `${workspace.root}/on-parent`,
    });
    expect(onParent.exitCode).toBe(4);
    expect(onParent.json.reason).toBe("correction_base_changed");
    expect(onParent.json.blockers[0]).toMatchObject({
      recorded: landed,
      requested: producer.baseCommit,
    });

    const worktreePath = `${workspace.root}/fix`;
    const dispatched = await dispatchAt(workspace, producer, {
      attemptId,
      commit: null,
      worktreePath,
    });
    expect(dispatched.json.blockers[0].reason).toBe("acknowledgement_pending");
    expect(dispatched.json.data.baseCommit).toBe(landed);

    const brief = await Bun.file(`${worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain(`invalidation cycle 1 of 3`);
    expect(brief).toContain(`Submission: ${first.submitted.json.data.submissionId}`);
    expect(brief).toContain(DEFECT.summary);
    expect(brief).toContain(DEFECT.evidence);
    expect(brief).toContain(`Found by: ${DEFECT.foundBy}`);
    expect(brief).toContain(`Landed commit: ${landed}`);
    expect(brief).toContain(`Your worktree starts at ${landed}, the landed commit.`);
    expect(brief).not.toContain("Start from the submitted commit above");
  }, 60_000);

  test("an invalidation with the correction budget spent waits for the direction of the user", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    let producer = await startProducer(workspace, undefined, {
      dependents: [{ key: "22.2", kind: "planning", title: "Decide the rollout order" }],
    });
    const dependents = producer.dependents;
    let result = await acceptedResult(workspace, producer, "# Result 0\n");

    // Each invalidation cycle changes the result, so three of them spend the budget of three.
    for (const round of [1, 2, 3]) {
      const invalidated = await invalidateResult(workspace, producer, {
        assignmentId: producer.assignmentId,
        revision: result.accepted.json.data.revision,
        defect: DEFECT,
      });
      expect(invalidated.json.data.cycle.cycleIndex).toBe(round);
      producer = await startRework(workspace, producer, {
        revision: invalidated.json.data.revision,
        commit: invalidated.json.data.cycle.startCommit,
        worktreePath: `${workspace.root}/fix-${round}`,
      });
      result = await acceptedResult(workspace, producer, `# Result ${round}\n`);
      expect(result.accepted.json.reason).toBe("assignment_accepted");
    }

    const consumer = dependents.get("22.2") ?? "";
    await acceptAssignment(workspace, producer, { assignmentId: consumer, revision: 1 });

    // A found defect is never refused, so the fourth one is recorded and pauses what read it.
    const spent = await invalidateResult(workspace, producer, {
      assignmentId: producer.assignmentId,
      revision: result.accepted.json.data.revision,
      defect: DEFECT,
    });
    expect(spent.exitCode).toBe(0);
    expect(spent.json.reason).toBe("result_invalidated");
    expect(spent.json.data.cycle).toBeNull();
    expect(spent.json.data.dependents).toEqual([
      expect.objectContaining({ assignmentId: consumer, paused: true }),
    ]);
    const direction = spent.json.data.direction;
    expect(direction).toMatchObject({ limitKind: "rework_cycles", limitValue: 3, state: "open" });

    const waiting = await frontierEntry(workspace, producer.assignmentId);
    expect(waiting.group).toBe("blocked");
    expect(waiting.entry.blockers).toEqual([
      {
        reason: "direction_required",
        directionRequestId: direction.directionRequestId,
        limitKind: "rework_cycles",
      },
    ]);
    const refused = await claim(workspace, producer, spent.json.data.revision);
    expect(refused.json.reason).toBe("assignment_not_dispatchable");

    await grantDirection(workspace, producer, direction, "Correct it once more.");
    expect((await frontierEntry(workspace, producer.assignmentId)).group).toBe("dispatchable");
    const next = await nextActions(workspace);
    expect(next.forAction("direct_limit")).toEqual([]);

    // The claim spends the direction, and the cycle it opens says under what approval it runs.
    const claimed = await claim(workspace, producer, spent.json.data.revision);
    expect(claimed.json.reason).toBe("assignment_claimed");
    const worktreePath = `${workspace.root}/fix-4`;
    const dispatched = await dispatchAt(workspace, producer, {
      attemptId: claimed.json.data.attemptId,
      commit: null,
      worktreePath,
    });
    // The correction starts at the commit that carries the result now.
    expect(dispatched.json.data.baseCommit).toBe(result.accepted.json.data.landing.landed);
    const brief = await Bun.file(`${worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain("invalidation cycle 4 of 3");
    expect(brief).toContain("This cycle runs past the recorded limit under approval");
    expect(brief).toContain(DEFECT.summary);
    // Four complete review cycles run here through separate CLI processes. A run took 24 s on CI
    // and 33.5 s once under a parallel load, so this test has a bound far above the 30 s default.
  }, 240_000);

  test("pauses only the work that read the invalid result and keeps the history", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace, undefined, {
      dependents: [
        { key: "22.2", kind: "planning", title: "Decide the rollout order" },
        { key: "22.3", kind: "production", title: "Build on the accepted result" },
      ],
    });
    const first = await acceptedResult(workspace, producer, "# Result\n");
    expect(first.accepted.json.reason).toBe("assignment_accepted");

    const dependents = producer.dependents;
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
      commit: invalidated.json.data.cycle.startCommit,
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
    const producer = await startProducer(workspace, undefined, {
      dependents: [
        { key: "22.4", kind: "production", title: "The other input", dependsOn: [] },
        {
          key: "22.5",
          kind: "planning",
          title: "Decide from both inputs",
          dependsOn: ["22.1", "22.4"],
        },
      ],
    });
    const first = await acceptedResult(workspace, producer, "# First\n");

    const registered = producer.dependents;
    const other = registered.get("22.4") ?? "";
    const consumer = registered.get("22.5") ?? "";

    // The second input is produced, reviewed, and accepted on its own assignment.
    const second = await startRework(workspace, producer, {
      revision: 1,
      // A later production dispatch of the source starts from the recorded tip (ADR 0020).
      commit: first.accepted.json.data.landing.to,
      worktreePath: `${workspace.root}/other`,
      assignmentId: other,
    });
    // Each input writes its own file, so the rewrite of one lands the other again.
    const otherResult = await acceptedResult(workspace, second, "# Other\n", "docs/other.md");
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
      commit: firstDefect.json.data.cycle.startCommit,
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
      commit: secondDefect.json.data.cycle.startCommit,
      worktreePath: `${workspace.root}/fix-other`,
      assignmentId: other,
    });
    await acceptedResult(workspace, secondFix, "# Other, corrected\n", "docs/other.md");

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
    const producer = await startProducer(workspace, undefined, {
      dependents: [
        { key: "22.2", kind: "planning", title: "Decide the rollout order" },
        { key: "22.3", kind: "production", title: "Roll out", dependsOn: ["22.2"] },
      ],
    });
    const first = await acceptedResult(workspace, producer, "# Result\n");
    expect(first.accepted.json.reason).toBe("assignment_accepted");

    const registered = producer.dependents;
    const planning = registered.get("22.2") ?? "";
    const dependent = registered.get("22.3") ?? "";

    const decided = await acceptAssignment(workspace, producer, {
      assignmentId: planning,
      revision: 1,
    });
    expect(decided.json.reason).toBe("assignment_accepted");

    await startRework(workspace, producer, {
      revision: 1,
      // A later production dispatch of the source starts from the recorded tip (ADR 0020).
      commit: first.accepted.json.data.landing.to,
      worktreePath: `${workspace.root}/rollout`,
      assignmentId: dependent,
    });

    const invalidated = await invalidateResult(workspace, producer, {
      assignmentId: planning,
      revision: decided.json.data.revision,
      defect: DEFECT,
    });
    expect(invalidated.json.reason).toBe("result_invalidated");
    // Planning work is never dispatched, so it is decided again and opens no cycle.
    expect(invalidated.json.data.cycle).toBeNull();
    expect(invalidated.json.data.direction).toBeNull();
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
    const producer = await startProducer(workspace, undefined, {
      dependents: [
        {
          key: "22.4",
          kind: "production",
          title: "Change a file the result also changed",
          dependsOn: [],
          writePaths: ["docs/result.md"],
        },
      ],
    });
    const first = await acceptedResult(workspace, producer, "# Result\n");

    const registered = producer.dependents;
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
            sourceKey: issueKey(1501),
            hold: "started",
            pathPairCount: 1,
          },
        ],
        command: `operator work overlaps --source ${issueKey(15)}`,
      },
    ]);

    const fixing = await startRework(workspace, producer, {
      revision: invalidated.json.data.revision,
      commit: invalidated.json.data.cycle.startCommit,
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
    const producer = await startProducer(workspace, undefined, {
      dependents: [
        {
          key: "22.4",
          kind: "production",
          title: "Change a file the result also changed",
          dependsOn: [],
          writePaths: ["docs/result.md"],
        },
      ],
    });
    const first = await acceptedResult(workspace, producer, "# Result\n");

    const registered = producer.dependents;
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
