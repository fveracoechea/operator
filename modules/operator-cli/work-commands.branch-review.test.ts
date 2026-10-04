import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test as bunTest } from "bun:test";
import {
  branchReport,
  finalBranch,
  type Registered,
  reviewedResult,
  SIBLING_ISSUE,
  startBranchReviewer,
  THIRD_ISSUE,
} from "./branch-review-fixture.ts";
import {
  acceptProduction,
  acceptReview,
  disposeFindings,
  grantDirection,
  makeReviewWorkspace,
  type Producer,
  reportReview,
  startProducer,
  startRework,
  type Workspace,
} from "./review-cycle-fixture.ts";
import { issueKey, withdrawIssues, workspaceTarget } from "./source-fixture.ts";
import { nextActions, requestId as request, runJson, workspaces } from "./workspace-fixture.ts";

// Each test runs producers, reviewers, a branch reviewer, and gate runs through the CLI.
// Each test states its own bound, because a process-wide default would set the bound of every
// file in the bun test process (#179).
function test(name: string, run: () => Promise<void> | void, timeoutMs = 240_000) {
  bunTest(name, run, timeoutMs);
}

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

/**
 * One branch round that finds a defect in the second commit, corrects it through its
 * invalidation cycle, and accepts the corrected result again. It returns the acceptance, which
 * registers the next branch review.
 */
async function correctedRound(
  workspace: Workspace,
  context: { producer: Producer; sibling: Producer; landedCommit: string },
  registered: Registered,
  round: number,
) {
  const reviewer = await startBranchReviewer(
    workspace,
    context.producer,
    registered,
    `branch-reviewer-${round}`,
  );
  const reported = await reportReview(
    workspace,
    reviewer,
    registered.reviewId,
    branchReport(workspace, registered.snapshotIdentity, [
      { key: `relation-${round}`, severity: "blocker", targets: [context.landedCommit] },
    ]),
  );
  expect(reported.json.reason).toBe("review_reported");
  const finding = reported.json.data.findings[0];
  const freed = await acceptReview(workspace, context.producer, {
    reviewAssignmentId: registered.assignmentId,
    attemptId: reviewer.attemptId,
    revision: reviewer.revision,
  });
  expect(freed.json.reason).toBe("assignment_accepted");

  const disposed = await disposeFindings(workspace, context.producer, registered.reviewId, [
    {
      findingId: finding.findingId,
      disposition: "corrected",
      reason: "The later commit has fewer dependents, so it is the cheaper target.",
      target: context.sibling.assignmentId,
    },
  ]);
  expect(disposed.json.reason).toBe("findings_disposed");
  expect(disposed.json.data.invalidated).toEqual([
    expect.objectContaining({ assignmentId: context.sibling.assignmentId }),
  ]);

  const frontier = await runJson(workspace, ["work", "frontier"]);
  const invalidated = (
    frontier.json.data.dispatchable as Array<{
      assignmentId: string;
      revision: number;
    }>
  ).find((one) => one.assignmentId === context.sibling.assignmentId);
  const correction = await startRework(workspace, context.sibling, {
    revision: invalidated?.revision ?? 0,
    // The correction starts at the landed commit, where the cycle says.
    commit: null,
    worktreePath: `${workspace.root}/correction-${round}`,
  });
  const result = await reviewedResult(workspace, correction, {
    text: `# Notes, corrected ${round}\n`,
    path: "notes/notes.md",
    worktree: `correction-reviewer-${round}`,
  });
  const accepted = await acceptProduction(workspace, correction, result);
  expect(accepted.json.reason).toBe("assignment_accepted");
  return accepted;
}

describe("the branch review of an integration branch", () => {
  test("the last acceptance of two code commits registers it in the same change, at the head", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const { producer, acceptedFirst, acceptedSecond } = await finalBranch(workspace);

    // The first acceptance leaves the sibling unaccepted, so the branch is not final.
    expect(acceptedFirst.json.data.branchReview).toBeNull();
    const registered = acceptedSecond.json.data.branchReview as Registered;
    expect(registered).toMatchObject({
      round: 1,
      direction: null,
      headCommit: acceptedSecond.json.data.landing.to,
    });

    // `crew next` only reads the registration, and offers the branch review as review work.
    const next = await nextActions(workspace);
    expect(next.forAction("claim_assignment").map((one) => one.assignmentId)).toContain(
      registered.assignmentId,
    );

    // The reviewer starts from that head and no other.
    const reviewer = await startBranchReviewer(workspace, producer, registered, "branch-reviewer");
    expect(reviewer.dispatched.data.baseCommit).toBe(registered.headCommit);
    const brief = await Bun.file(`${reviewer.worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain(
      `- Snapshot: ${registered.snapshotId} (identity ${registered.snapshotIdentity})`,
    );
    expect(brief).toContain(
      `- Fixed point: ${producer.baseCommit}, the base of the integration branch.`,
    );
    expect(brief).toContain(`git diff ${producer.baseCommit}...HEAD`);
    expect(brief).toContain("`review_finding_untargeted`");
    // Each item spec reaches the reviewer as a fixed copy.
    expect(
      await Bun.file(`${reviewer.worktreePath}/.operator/local/review/spec-1.md`).exists(),
    ).toBe(true);
    expect(
      await Bun.file(`${reviewer.worktreePath}/.operator/local/review/spec-2.md`).exists(),
    ).toBe(true);
    // The fixed text of the source, stored at registration, is a spec input too, so a later edit
    // of the parent issue never changes what the branch review reads.
    expect(brief).toContain("- spec source: .operator/local/review/spec-1.md [");
    const sourceText = await Bun.file(
      `${reviewer.worktreePath}/.operator/local/review/spec-1.md`,
    ).json();
    expect(sourceText).toMatchObject({ body: "The body of issue 15." });
    expect(
      await Bun.file(`${reviewer.worktreePath}/.operator/local/review/spec-3.md`).exists(),
    ).toBe(true);
    // The branch review reads no behavior change list, so it states no such coverage.
    expect(brief).toContain("A branch review requires diff, requirements, checks in `checked`.");

    // A repeat of the acceptance registers nothing more.
    const again = await nextActions(workspace);
    expect(
      again
        .forAction("claim_assignment")
        .filter((one) => one.assignmentId !== registered.assignmentId),
    ).toEqual([]);
  });

  test("a source with one code commit registers none", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const result = await reviewedResult(workspace, producer, {
      text: "# Result\n",
      worktree: "reviewer-one",
    });

    const accepted = await acceptProduction(workspace, producer, result);

    expect(accepted.json.reason).toBe("assignment_accepted");
    expect(accepted.json.data.branchReview).toBeNull();
    const frontier = await runJson(workspace, ["work", "frontier"]);
    const keys = Object.values(frontier.json.data).flatMap((one) =>
      Array.isArray(one)
        ? (one as Array<{ sourceKey: string }>).map((entry) => entry.sourceKey)
        : [],
    );
    expect(keys.filter((key) => key.startsWith("branch-review."))).toEqual([]);
  });

  test("a report that names another snapshot, or a finding with no target or a foreign target, refuses", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const { producer, acceptedSecond } = await finalBranch(workspace);
    const registered = acceptedSecond.json.data.branchReview as Registered;
    const reviewer = await startBranchReviewer(workspace, producer, registered, "branch-reviewer");

    const drifted = await reportReview(
      workspace,
      reviewer,
      registered.reviewId,
      branchReport(workspace, "another-snapshot"),
    );
    expect(drifted.exitCode).not.toBe(0);
    expect(drifted.json.reason).toBe("snapshot_drift");
    expect(drifted.json.blockers[0]).toMatchObject({ recorded: registered.snapshotIdentity });

    const untargeted = await reportReview(
      workspace,
      reviewer,
      registered.reviewId,
      branchReport(workspace, registered.snapshotIdentity, [
        { key: "loose", severity: "blocker", targets: [] },
      ]),
    );
    expect(untargeted.json.reason).toBe("review_finding_untargeted");
    expect(untargeted.json.blockers[0]).toMatchObject({ axis: "standards", key: "loose" });

    const foreign = await reportReview(
      workspace,
      reviewer,
      registered.reviewId,
      branchReport(workspace, registered.snapshotIdentity, [
        { key: "foreign", severity: "blocker", targets: [producer.baseCommit] },
      ]),
    );
    expect(foreign.json.reason).toBe("review_finding_target_unknown");

    // Nothing was recorded, so the review still takes its one report.
    const shown = await runJson(workspace, ["review", "show", "--review", registered.reviewId]);
    expect(shown.json.data.review.state).toBe("registered");
  });

  test("a corrected finding invalidates its one target, and the re-acceptance registers the next review", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const { producer, sibling, acceptedSecond } = await finalBranch(workspace);
    const registered = acceptedSecond.json.data.branchReview as Registered;
    const landing = acceptedSecond.json.data.landing;
    const reviewer = await startBranchReviewer(workspace, producer, registered, "branch-reviewer");
    const reported = await reportReview(
      workspace,
      reviewer,
      registered.reviewId,
      branchReport(workspace, registered.snapshotIdentity, [
        { key: "relation", severity: "blocker", targets: [landing.from, landing.to] },
      ]),
    );
    expect(reported.json.reason).toBe("review_reported");
    const finding = reported.json.data.findings[0];

    // A blocker is never deferred, and a correction names exactly one target it targets.
    const deferred = await disposeFindings(workspace, producer, registered.reviewId, [
      { findingId: finding.findingId, disposition: "deferred", reason: "Later.", followUp: "#1" },
    ]);
    expect(deferred.json.reason).toBe("blocker_not_deferrable");
    const untargeted = await disposeFindings(workspace, producer, registered.reviewId, [
      { findingId: finding.findingId, disposition: "corrected", reason: "Fix it." },
    ]);
    expect(untargeted.json.reason).toBe("correction_target_required");
    const next = await nextActions(workspace);
    expect(next.forAction("dispose_findings").map((one) => one.reviewId)).toContain(
      registered.reviewId,
    );
    expect(
      next.forAction("dispose_findings").find((one) => one.reviewId === registered.reviewId)
        ?.detail,
    ).toBe(
      "1 branch finding(s) carry no disposition. A corrected one names its one target assignment.",
    );

    const disposed = await disposeFindings(workspace, producer, registered.reviewId, [
      {
        findingId: finding.findingId,
        disposition: "corrected",
        reason: "The later commit has fewer dependents, so it is the cheaper target.",
        target: sibling.assignmentId,
      },
    ]);
    expect(disposed.json.reason).toBe("findings_disposed");
    expect(disposed.json.data.invalidated).toEqual([
      expect.objectContaining({ assignmentId: sibling.assignmentId }),
    ]);
    const frontier = await runJson(workspace, ["work", "frontier"]);
    const states = new Map(
      Object.values(frontier.json.data)
        .flatMap((one) =>
          Array.isArray(one) ? (one as Array<{ assignmentId: string; state: string }>) : [],
        )
        .map((one) => [one.assignmentId, one.state]),
    );
    expect(states.get(sibling.assignmentId)).toBe("invalidated");
    expect(states.get(producer.assignmentId)).toBe("accepted");

    const invalidated = (
      frontier.json.data.dispatchable as Array<{
        assignmentId: string;
        revision: number;
      }>
    ).find((one) => one.assignmentId === sibling.assignmentId);
    const correction = await startRework(workspace, sibling, {
      revision: invalidated?.revision ?? 0,
      // The correction starts at the landed commit, where the cycle says.
      commit: null,
      worktreePath: `${workspace.root}/correction`,
    });
    const result = await reviewedResult(workspace, correction, {
      text: "# Notes, corrected\n",
      path: "notes/notes.md",
      worktree: "correction-reviewer",
    });
    const accepted = await acceptProduction(workspace, correction, result);

    expect(accepted.json.reason).toBe("assignment_accepted");
    const nextRound = accepted.json.data.branchReview as Registered;
    expect(nextRound).toMatchObject({ round: 2, direction: null });
    expect(nextRound.snapshotIdentity).not.toBe(registered.snapshotIdentity);
    const shown = await runJson(workspace, ["review", "show", "--review", nextRound.reviewId]);
    expect(shown.json.data.snapshot.commits).toEqual([
      expect.objectContaining({ assignmentId: producer.assignmentId }),
      expect.objectContaining({
        assignmentId: sibling.assignmentId,
        submissionId: result.submissionId,
      }),
    ]);
    // The next round reads every earlier review of the source as context.
    const nextReviewer = await startBranchReviewer(
      workspace,
      producer,
      nextRound,
      "branch-reviewer-2",
    );
    const brief = await Bun.file(`${nextReviewer.worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain(
      `Branch review ${registered.reviewId} of snapshot ${registered.snapshotId}`,
    );
    expect(brief).toContain(
      `${finding.findingId} standards blocker corrected targets ${landing.from}, ${landing.to}`,
    );
  });

  test("a fourth branch review waits on a direction request until the user directs it", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const { producer, sibling, acceptedSecond } = await finalBranch(workspace);
    const landing = acceptedSecond.json.data.landing;
    const context = { producer, sibling, landedCommit: landing.to };

    let registered = acceptedSecond.json.data.branchReview as Registered;
    for (const round of [1, 2, 3]) {
      const accepted = await correctedRound(workspace, context, registered, round);
      registered = accepted.json.data.branchReview as Registered;
      expect(registered.round).toBe(round + 1);
      // The rewrite put the correction in place, so the next round names its new commit.
      context.landedCommit = accepted.json.data.landing.landed;
    }

    // Three rounds reported, so the fourth is registered with a direction request.
    expect(registered.direction).not.toBeNull();
    const next = await nextActions(workspace);
    expect(next.forAction("direct_limit").map((one) => one.assignmentId)).toContain(
      registered.assignmentId,
    );
    expect(next.forAction("claim_assignment").map((one) => one.assignmentId)).not.toContain(
      registered.assignmentId,
    );
    const refused = await runJson(workspace, [
      "work",
      "claim",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--assignment",
      registered.assignmentId,
      "--revision",
      "1",
    ]);
    expect(refused.json.reason).toBe("assignment_not_dispatchable");
    expect(refused.json.blockers[0]).toMatchObject({
      reason: "direction_required",
      limitKind: "branch_reviews",
    });

    const granted = await grantDirection(
      workspace,
      producer,
      registered.direction as NonNullable<Registered["direction"]>,
      "Run a fourth branch review.",
    );
    expect(granted.json.reason).toBe("approval_granted");
    const reviewer = await startBranchReviewer(
      workspace,
      producer,
      registered,
      "branch-reviewer-4",
    );
    expect(reviewer.dispatched.data.baseCommit).toBe(registered.headCommit);
    // The claim that the user permitted spent the direction, with the approval that carried it.
    const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`, {
      readonly: true,
    });
    try {
      const spent = sqlite
        .query(
          "select state, approval_id as approvalId from direction_requests where assignment_id = ?",
        )
        .get(registered.assignmentId);
      expect(spent).toMatchObject({ state: "directed", approvalId: expect.any(String) });
    } finally {
      sqlite.close();
    }
  });

  test("the withdrawal that makes the branch final registers it in the same change", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const { producer, acceptedSecond } = await finalBranch(workspace, { third: "registered" });
    // The third item is not accepted, so the branch is not final yet.
    expect(acceptedSecond.json.data.branchReview).toBeNull();

    const { registered } = await withdrawIssues(workspaceTarget(workspace), producer.ownerToken, {
      sourceKind: "specification",
      parent: 15,
      numbers: [THIRD_ISSUE],
    });

    expect(registered.json.reason).toBe("work_registered");
    expect(registered.json.data.branchReview).toMatchObject({
      round: 1,
      headCommit: acceptedSecond.json.data.landing.to,
    });
  });

  test("a withdrawal waits on a branch review attempt that holds its commit, and closes one with none", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const { producer, sibling, acceptedSecond } = await finalBranch(workspace);
    const registered = acceptedSecond.json.data.branchReview as Registered;
    const reviewer = await startBranchReviewer(workspace, producer, registered, "branch-reviewer");

    const { plan } = await withdrawIssues(workspaceTarget(workspace), producer.ownerToken, {
      sourceKind: "specification",
      parent: 15,
      numbers: [SIBLING_ISSUE],
    });
    const held = await Bun.file(`${workspace.repo}/${plan.json.data.planPath}`).json();
    expect(held.refusals).toContainEqual({
      reason: "withdrawal_attempt_active",
      key: issueKey(SIBLING_ISSUE),
      assignmentId: sibling.assignmentId,
      attemptId: reviewer.attemptId,
      holder: registered.assignmentId,
    });
  });

  test("a withdrawal closes the registered branch review that holds its commit, and registers none", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    // Two commits stay after the withdrawal, so only the pending take-out holds the next review.
    const { producer, acceptedSecond } = await finalBranch(workspace, { third: "accepted" });
    const registered = acceptedSecond.json.data.branchReview as Registered;

    const { registered: withdrawn } = await withdrawIssues(
      workspaceTarget(workspace),
      producer.ownerToken,
      { sourceKind: "specification", parent: 15, numbers: [SIBLING_ISSUE] },
    );

    expect(withdrawn.json.reason).toBe("work_registered");
    // The branch still holds the withdrawn commit until its take-out, so it is not final.
    expect(withdrawn.json.data.branchReview).toBeNull();
    const shown = await runJson(workspace, ["review", "show", "--review", registered.reviewId]);
    expect(shown.json.data.review.state).toBe("withdrawn");
    const next = await nextActions(workspace);
    expect(next.actions.filter((one) => one.assignmentId === registered.assignmentId)).toEqual([]);
  });

  test("a withdrawal leaves a branch review that an earlier item already closed as it is", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const { producer, acceptedSecond } = await finalBranch(workspace, { third: "accepted" });
    const registered = acceptedSecond.json.data.branchReview as Registered;
    const before = await runJson(workspace, ["review", "show", "--review", registered.reviewId]);

    // The snapshot holds the commits of both items. The first withdrawal closes the review, and
    // the review machine leaves the closed branch review as it is for the second.
    const { registered: withdrawn } = await withdrawIssues(
      workspaceTarget(workspace),
      producer.ownerToken,
      { sourceKind: "specification", parent: 15, numbers: [SIBLING_ISSUE, THIRD_ISSUE] },
    );

    expect(withdrawn.json.reason).toBe("work_registered");
    const after = await runJson(workspace, ["review", "show", "--review", registered.reviewId]);
    expect(after.json.data.review).toMatchObject({
      state: "withdrawn",
      revision: before.json.data.review.revision + 1,
    });
  });

  test("a withdrawal on a snapshot that a branch review already reads registers none", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const { producer, acceptedSecond } = await finalBranch(workspace);
    const registered = acceptedSecond.json.data.branchReview as Registered;
    expect(registered).not.toBeNull();
    // A person adds an item to the parent, and a new read registers it, so the branch is not
    // final until the item is withdrawn again, and its withdrawal leaves the same snapshot.
    const added = await addParentItem(workspace, producer.ownerToken, 1509);
    expect(added.json.reason).toBe("work_registered");

    const { registered: withdrawn } = await withdrawIssues(
      workspaceTarget(workspace),
      producer.ownerToken,
      { sourceKind: "specification", parent: 15, numbers: [1509] },
    );

    expect(withdrawn.json.reason).toBe("work_registered");
    expect(withdrawn.json.data.branchReview).toBeNull();
    const next = await nextActions(workspace);
    const claims = next
      .forAction("claim_assignment")
      .filter((one) => one.assignmentId !== producer.assignmentId);
    expect(claims.map((one) => one.assignmentId)).toEqual([registered.assignmentId]);
  });
});

/**
 * Adds one production item to parent issue 15 in the GitHub fake, as a person does, and registers
 * it through a new read behind its approval.
 */
async function addParentItem(workspace: Workspace, ownerToken: string, number: number) {
  const statePath = `${workspace.github}/state.json`;
  const state = await Bun.file(statePath).json();
  const [model] = state.subIssues["15"];
  const issue = {
    ...model,
    id: model.id + number,
    number,
    title: `Item ${number}`,
    body: `The approved scope of item ${number}.`,
  };
  state.issues[String(number)] = issue;
  state.subIssues["15"] = [...state.subIssues["15"], issue];
  await Bun.write(statePath, JSON.stringify(state, null, 2));

  const inputPath = `${workspace.root}/work-input-${crypto.randomUUID()}.json`;
  await Bun.write(
    inputPath,
    JSON.stringify({
      sourceKind: "specification",
      source: issueKey(15),
      items: [
        {
          issue: issueKey(number),
          kind: "production",
          acceptanceRequirements: ["The quality gate passes."],
          permissions: { writePaths: ["added/"], allowedCommands: ["bun test"], network: false },
          fixedInputs: [],
        },
      ],
    }),
  );
  const plan = await runJson(workspace, ["work", "register", "--plan", "--input", inputPath]);
  const approval = plan.json.data?.approval;
  if (approval !== null && approval !== undefined) {
    const approvalPath = `${workspace.root}/approval-${crypto.randomUUID()}.json`;
    await Bun.write(
      approvalPath,
      JSON.stringify({ ...approval, exactText: "Yes, add that item.", grantedBy: "human" }),
    );
    await runJson(workspace, [
      "approval",
      "grant",
      "--request",
      request(),
      "--owner-token",
      ownerToken,
      "--input",
      approvalPath,
    ]);
  }
  return runJson(workspace, [
    "work",
    "register",
    "--request",
    request(),
    "--owner-token",
    ownerToken,
    "--input",
    inputPath,
    "--plan-revision",
    String(plan.json.data?.planRevision ?? "none"),
  ]);
}
