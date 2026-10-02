import { Database } from "bun:sqlite";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acceptProduction,
  commitArtifact,
  makeReviewWorkspace,
  type Producer,
  reportBody,
  reportReview,
  startProducer,
  startReviewer,
  submissionBody,
  submit,
  type Workspace,
  writeInput,
} from "./review-cycle-fixture.ts";
import {
  nextActions,
  requestId as request,
  runJson,
  runOperator,
  workspaces,
} from "./workspace-fixture.ts";

// Each test creates Git worktrees and runs several CLI processes under the parallel CI gate.
setDefaultTimeout(60_000);

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

type OutsideChange = {
  changeId: string;
  place: string;
  path: string;
  change: string;
  security: boolean;
  disposition: string | null;
};

/** Submits one committed result and returns what the review records about it. */
async function submitResult(
  workspace: Workspace,
  producer: Producer,
  env: Record<string, string> = {},
) {
  const artifact = await commitArtifact(workspace, producer, "# Result\n");
  const submitted = await submit(
    workspace,
    producer,
    submissionBody(producer, artifact),
    producer.attemptId,
    env,
  );
  expect(submitted.json.reason).toBe("result_submitted");
  const shown = await runJson(workspace, [
    "review",
    "show",
    "--review",
    submitted.json.data.reviewId,
  ]);
  return {
    artifact,
    submitted,
    changes: shown.json.data.submission.outsideChanges as OutsideChange[],
  };
}

async function dispose(
  workspace: Workspace,
  producer: Producer,
  submissionId: string,
  dispositions: unknown[],
) {
  return runJson(workspace, [
    "work",
    "dispose",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--submission",
    submissionId,
    "--input",
    await writeInput(workspace, { dispositions }),
  ]);
}

/** Runs the review to a report with no finding, so only the outside changes stand in the way. */
async function reviewClean(
  workspace: Workspace,
  producer: Producer,
  result: Awaited<ReturnType<typeof submitResult>>,
) {
  const { submitted, artifact } = result;
  const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
  const reported = await reportReview(
    workspace,
    reviewer,
    submitted.json.data.reviewId,
    reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
  );
  expect(reported.json.reason).toBe("review_reported");
}

describe("operator attempt submit records each change outside the worktree", () => {
  test("a file written next to the worktree during the attempt is recorded, not refused", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    await Bun.write(`${workspace.root}/before.txt`, "there before the attempt\n");
    const producer = await startProducer(workspace);
    await Bun.write(`${workspace.root}/stray.txt`, "written by someone during the attempt\n");

    const { submitted, changes } = await submitResult(workspace, producer);

    expect(submitted.exitCode).toBe(6);
    expect(submitted.json.data.outsideChanges).toBe(1);
    expect(changes).toEqual([
      expect.objectContaining({
        place: "worktree-parent",
        path: expect.stringMatching(/\/stray\.txt$/),
        change: "added",
        security: false,
        disposition: null,
      }),
    ]);
  });

  test("a change to the config of the controlling checkout is recorded as a security change", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    await Bun.$`git -C ${workspace.repo} config core.fsmonitor ./run-me`.quiet();
    await Bun.write(`${workspace.repo}/untracked.txt`, "left in the checkout\n");

    const { changes } = await submitResult(workspace, producer);

    expect(changes.map(({ place, change, security }) => ({ place, change, security }))).toEqual([
      { place: "checkout", change: "added", security: false },
      { place: "git-config", change: "changed", security: true },
    ]);
  });

  test("the scan leaves out every other worktree and the work inside it", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const sibling = `${workspace.root}/sibling`;
    await Bun.$`git -C ${workspace.repo} worktree add -q -b sibling ${sibling}`.quiet();
    await Bun.write(`${sibling}/work.txt`, "another Operative's work\n");

    const { submitted, changes } = await submitResult(workspace, producer);

    expect(submitted.json.data.outsideChanges).toBe(0);
    expect(changes).toEqual([]);
  });

  test("a worktree in the home folder is not scanned, and the scan says so", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const env = { HOME: workspace.root };
    const producer = await startProducer(workspace, undefined, { env });
    await Bun.write(`${workspace.root}/home-file.txt`, "a file in the home folder\n");

    const { changes } = await submitResult(workspace, producer, env);

    // A part that was not read is never a pass, so it waits for a disposition like any change.
    expect(changes).toEqual([
      expect.objectContaining({ place: "worktree-parent", change: "unscanned" }),
    ]);
    expect(changes.some((one) => one.path.endsWith("home-file.txt"))).toBe(false);
  });

  test("an attempt with no recorded scan records the scan as not run", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`);
    sqlite.query("update attempt_dispatch set outside_scan = null").run();
    sqlite.close();

    const { changes } = await submitResult(workspace, producer);

    expect(changes.map(({ place, change, security }) => ({ place, change, security }))).toEqual([
      { place: "checkout", change: "unscanned", security: true },
      { place: "worktree-parent", change: "unscanned", security: false },
    ]);
  });
});

describe("operator work accept waits for a disposition of each outside change", () => {
  test("refuses with outside_changes_undisposed, and accepts once the change is explained", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    await Bun.write(`${workspace.root}/stray.txt`, "written during the attempt\n");
    const result = await submitResult(workspace, producer);
    const { submitted, changes } = result;
    await reviewClean(workspace, producer, result);
    const accept = () =>
      acceptProduction(workspace, producer, {
        submissionId: submitted.json.data.submissionId,
        revision: submitted.json.data.revision,
      });

    const refused = await accept();
    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("outside_changes_undisposed");
    expect(refused.json.blockers).toEqual([
      {
        reason: "outside_changes_undisposed",
        submissionId: submitted.json.data.submissionId,
        count: 1,
        security: 0,
      },
    ]);

    const next = await nextActions(workspace);
    expect(next.of("dispose_outside_changes").blocker).toBeNull();
    expect(next.forAction("accept_assignment").map((one) => one.assignmentId)).not.toContain(
      producer.assignmentId,
    );

    const explained = await dispose(workspace, producer, submitted.json.data.submissionId, [
      {
        changeId: changes[0]?.changeId,
        disposition: "explained",
        reason: "The user wrote this file by hand during the attempt.",
        evidence: "The user said so in this session.",
      },
    ]);
    expect(explained.exitCode).toBe(0);
    expect(explained.json.data.outstanding).toEqual([]);

    const accepted = await accept();
    expect(accepted.json.reason).toBe("assignment_accepted");
  });

  test("the refusal gives a summary and points to the details, and names no path", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    for (const name of ["one", "two", "three"]) {
      await Bun.write(`${workspace.root}/${name}-stray.txt`, `${name}\n`);
    }
    const result = await submitResult(workspace, producer);
    const { submitted } = result;
    await reviewClean(workspace, producer, result);

    const refused = await runOperator(workspace, [
      "work",
      "accept",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--assignment",
      producer.assignmentId,
      "--attempt",
      producer.attemptId,
      "--revision",
      String(submitted.json.data.revision),
      "--submission",
      submitted.json.data.submissionId,
    ]);

    expect(refused.stdout).toContain("3 outside change(s)");
    expect(refused.stdout).toContain("operator review show");
    expect(refused.stdout).not.toContain("stray.txt");
  });
});

describe("operator work dispose", () => {
  test("never deletes a file, and `removed` passes only when a new scan no longer finds it", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const stray = `${workspace.root}/stray.txt`;
    await Bun.write(stray, "written during the attempt\n");
    const { submitted, changes } = await submitResult(workspace, producer);
    const removal = [{ changeId: changes[0]?.changeId, disposition: "removed" }];

    const refused = await dispose(workspace, producer, submitted.json.data.submissionId, removal);
    expect(refused.exitCode).toBe(3);
    expect(refused.json.blockers).toEqual([
      expect.objectContaining({
        reason: "outside_change_not_removed",
        path: expect.stringMatching(/\/stray\.txt$/),
      }),
    ]);
    // Only the person deletes a file written outside the worktree.
    expect(await Bun.file(stray).exists()).toBe(true);

    await Bun.$`rm ${stray}`.quiet();
    const removed = await dispose(workspace, producer, submitted.json.data.submissionId, removal);
    expect(removed.exitCode).toBe(0);
    expect(removed.json.data.disposed).toEqual([
      { changeId: changes[0]?.changeId, disposition: "removed" },
    ]);
  });

  test("a change in the hooks of the checkout asks the user before it is kept", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    await Bun.write(`${workspace.repo}/.git/hooks/pre-commit`, "#!/bin/sh\necho run\n");
    const result = await submitResult(workspace, producer);
    const { submitted, changes } = result;
    expect(changes).toEqual([
      expect.objectContaining({ place: "git-hooks", change: "added", security: true }),
    ]);
    const hook = changes[0];
    const explanation = {
      changeId: hook?.changeId,
      disposition: "explained",
      reason: "The hook runs the formatter.",
      evidence: "The hook text calls only echo.",
    };

    const refused = await dispose(workspace, producer, submitted.json.data.submissionId, [
      explanation,
    ]);
    expect(refused.exitCode).toBe(3);
    expect(refused.json.blockers).toEqual([
      {
        reason: "outside_change_approval_missing",
        changeId: hook?.changeId,
        approval: {
          action: "outside-change-keep",
          targets: [hook?.path],
          scope: submitted.json.data.submissionId,
          requestRevision: hook?.changeId,
        },
      },
    ]);

    await reviewClean(workspace, producer, result);
    // A security change goes to the user, so the crew cannot settle it alone.
    expect((await nextActions(workspace)).of("dispose_outside_changes").blocker).toBe(
      "approval_required",
    );

    const granted = await runJson(workspace, [
      "approval",
      "grant",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--input",
      await writeInput(workspace, {
        ...refused.json.blockers[0].approval,
        exactText: "Keep the pre-commit hook.",
        grantedBy: "human",
      }),
    ]);
    expect(granted.exitCode).toBe(0);

    const kept = await dispose(workspace, producer, submitted.json.data.submissionId, [
      explanation,
    ]);
    expect(kept.exitCode).toBe(0);
    expect(kept.json.data.outstanding).toEqual([]);
  });
});
