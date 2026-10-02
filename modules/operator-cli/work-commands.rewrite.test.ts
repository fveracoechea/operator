import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { issueKey, withdrawIssues, workspaceTarget } from "./source-fixture.ts";
// Bun has no file removal API.
import { rm } from "node:fs/promises";
import {
  acceptProduction,
  acceptReview,
  commitArtifact,
  delegateRework,
  invalidateResult,
  makeReviewWorkspace,
  passCandidateGate,
  type Producer,
  reportBody,
  reportReview,
  startProducer,
  startReviewer,
  startRework,
  startSibling,
  submissionBody,
  submit,
  type Workspace,
} from "./review-cycle-fixture.ts";
import { nextActions, requestId as request, runJson, workspaces } from "./workspace-fixture.ts";

// Each test lands three results and one correction through separate CLI processes.
setDefaultTimeout(180_000);

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

const DEFECT = {
  summary: "The accepted result drops every second record.",
  evidence: "docs/result.md:1 and the failing rerun of bun test.",
  foundBy: "the Operative on 22.3",
};

const NOTES = { key: "22.2", kind: "production" as const, title: "Write the notes" };
const OTHER = { key: "22.3", kind: "production" as const, title: "Write the other file" };

async function branchOf(workspace: Workspace): Promise<string> {
  const format = "--format=%(refname:short)";
  const listed =
    await Bun.$`git -C ${workspace.repo} for-each-ref ${format} refs/heads/operator/integration/`.text();
  return listed.trim().split("\n")[0] ?? "";
}

/** The commits of the branch from its base, oldest first. */
async function commitsOf(workspace: Workspace, branch: string, base: string): Promise<string[]> {
  const listed =
    await Bun.$`git -C ${workspace.repo} rev-list --reverse --first-parent ${`${base}..refs/heads/${branch}`}`.text();
  return listed.trim().split("\n").filter(Boolean);
}

async function patchOf(workspace: Workspace, commit: string): Promise<string> {
  return Bun.$`git -C ${workspace.repo} diff-tree -p --no-renames ${commit}^ ${commit}`.text();
}

/**
 * Commits, submits, reviews, and accepts one result. The reviewer is accepted first, so its crew
 * slot is free for the next round.
 */
async function landResult(
  workspace: Workspace,
  producer: Producer,
  options: { text: string; path: string },
) {
  const artifact = await commitArtifact(workspace, producer, options.text, options.path);
  const submitted = await submit(
    workspace,
    producer,
    submissionBody(producer, artifact, { assignmentRevision: producer.assignmentRevision }),
  );
  expect(submitted.json.reason).toBe("result_submitted");
  const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit, {
    worktreePath: `${workspace.root}/reviewer-${crypto.randomUUID().slice(0, 8)}`,
  });
  const reported = await reportReview(
    workspace,
    reviewer,
    submitted.json.data.reviewId,
    reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
  );
  expect(reported.json.reason).toBe("review_reported");
  await acceptReview(workspace, producer, {
    reviewAssignmentId: submitted.json.data.reviewAssignmentId,
    attemptId: reviewer.attemptId,
    revision: reviewer.revision,
  });
  const accepted = await acceptProduction(workspace, producer, {
    submissionId: submitted.json.data.submissionId,
    revision: submitted.json.data.revision,
  });
  return { artifact, submitted, accepted };
}

/** Three results on one branch, each in its own file, in the order 22.1, 22.2, 22.3. */
async function threeLanded(workspace: Workspace) {
  const producer = await startProducer(workspace, undefined, {
    dependents: [
      { ...NOTES, dependsOn: [], writePaths: ["notes/"] },
      { ...OTHER, dependsOn: [], writePaths: ["other/"] },
    ],
  });
  const branch = await branchOf(workspace);
  const first = await landResult(workspace, producer, {
    text: "# Result\n",
    path: "docs/result.md",
  });
  expect(first.accepted.json.reason).toBe("assignment_accepted");
  const notes = await startSibling(workspace, producer, NOTES.key);
  const second = await landResult(workspace, notes, { text: "# Notes\n", path: "notes/notes.md" });
  expect(second.accepted.json.reason).toBe("assignment_accepted");
  const other = await startSibling(workspace, producer, OTHER.key);
  const third = await landResult(workspace, other, { text: "# Other\n", path: "other/other.md" });
  expect(third.accepted.json.reason).toBe("assignment_accepted");
  return { producer, notes, other, branch, first, second, third };
}

describe("operator work accept rewrites a corrected landed commit in place", () => {
  test("a correction of the first of three commits rebuilds the branch in the same order", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { maxActiveAgents: 8 });
    const { producer, notes, other, branch, first } = await threeLanded(workspace);
    const before = await commitsOf(workspace, branch, producer.baseCommit);
    expect(before).toHaveLength(3);
    const landed = first.artifact.commit;
    expect(before[0]).toBe(landed);

    const invalidated = await invalidateResult(workspace, producer, {
      assignmentId: producer.assignmentId,
      revision: first.accepted.json.data.revision,
      defect: DEFECT,
    });
    expect(invalidated.json.reason).toBe("result_invalidated");
    // The correction starts at the landed commit, and its base is the parent of that commit.
    expect(invalidated.json.data.cycle.startCommit).toBe(landed);

    const fixing = await startRework(workspace, producer, {
      revision: invalidated.json.data.revision,
      commit: null,
      worktreePath: `${workspace.root}/fix`,
    });
    expect(fixing.baseCommit).toBe(landed);
    const brief = await Bun.file(`${fixing.worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain(`Your worktree starts at ${landed}, the landed commit.`);

    const artifact = await commitArtifact(
      workspace,
      fixing,
      "# Result\n\nEvery record.\n",
      "docs/result.md",
    );
    const reviewed = await reviewOnly(workspace, fixing, artifact);
    const gated = await gatedTrees(workspace, fixing);
    const checkouts = [producer, notes, other, fixing].map((one) => one.worktreePath);
    const status = () =>
      Promise.all(
        [workspace.repo, ...checkouts].map((one) => Bun.$`git -C ${one} status --porcelain`.text()),
      );
    const untouched = await status();
    const accepted = await acceptProduction(workspace, fixing, { ...reviewed, gate: false });

    expect(accepted.json.reason).toBe("assignment_accepted");
    // The CLI moves a ref that it built only from reviewed patches, and it writes no file (R1, D5).
    expect(await status()).toEqual(untouched);
    const landing = accepted.json.data.landing;
    expect(landing).toMatchObject({ kind: "rewrite", from: before[2] });
    const after = await commitsOf(workspace, branch, producer.baseCommit);
    // The branch moved once, from the old tip to the rebuilt tip.
    expect(landing.to).toBe(after[2]);
    expect(after).toHaveLength(3);
    expect(after[0]).toBe(landing.landed);
    // The rebuilt range was gated in order, one run at the key of each commit (ADR 0021).
    expect(gated).toEqual(await Promise.all(after.map((one) => treeOf(workspace, one))));
    expect(await patchOf(workspace, after[0] ?? "")).toContain("+Every record.");
    // Each later commit landed again with a new identity and an equal patch.
    for (const index of [1, 2]) {
      expect(after[index]).not.toBe(before[index]);
      expect(await patchOf(workspace, after[index] ?? "")).toBe(
        await patchOf(workspace, before[index] ?? ""),
      );
    }
    expect(landing.rewrite).toEqual({
      replaced: landed,
      relanded: [
        { assignmentId: notes.assignmentId, from: before[1], to: after[1] },
        { assignmentId: other.assignmentId, from: before[2], to: after[2] },
      ],
      takenOut: [],
    });
    const next = await nextActions(workspace);
    expect(next.names).not.toContain("settle_landing");

    // The branch is final again, so its next branch review names the rebuilt commits.
    const review = accepted.json.data.branchReview;
    expect(review.headCommit).toBe(after[2]);
    const shown = await runJson(workspace, ["review", "show", "--review", review.reviewId]);
    expect(shown.json.data.snapshot.commits.map((one: { commit: string }) => one.commit)).toEqual(
      after,
    );
  });

  test("a later commit whose patch changes is taken out with its dependent, and lands on the tip later", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { maxActiveAgents: 12 });
    const producer = await startProducer(workspace, undefined, {
      dependents: [
        { key: "22.2", kind: "production", title: "Change the result", writePaths: ["docs/"] },
        {
          key: "22.3",
          kind: "production",
          title: "Use the change",
          dependsOn: ["22.2"],
          writePaths: ["other/"],
        },
      ],
    });
    const branch = await branchOf(workspace);
    const first = await landResult(workspace, producer, {
      text: lines({}),
      path: "docs/result.md",
    });
    const changer = await startSibling(workspace, producer, "22.2");
    const changed = await landResult(workspace, changer, {
      text: lines({ 5: "changed five" }),
      path: "docs/result.md",
    });
    expect(changed.accepted.json.reason).toBe("assignment_accepted");
    const user = await startSibling(workspace, producer, "22.3");
    const used = await landResult(workspace, user, { text: "# Other\n", path: "other/other.md" });
    expect(used.accepted.json.reason).toBe("assignment_accepted");
    const before = await commitsOf(workspace, branch, producer.baseCommit);

    const fixing = await correct(workspace, producer, first);
    // The fix sits two lines above the change of 22.2, so that patch lands again as another patch.
    const fixed = await landResult(workspace, fixing, {
      text: lines({ 2: "fixed two" }),
      path: "docs/result.md",
    });

    expect(fixed.accepted.json.reason).toBe("assignment_accepted");
    const landing = fixed.accepted.json.data.landing;
    expect(landing.rewrite.takenOut).toEqual([
      { assignmentId: changer.assignmentId, commit: before[1], cause: "patch-changed" },
      { assignmentId: user.assignmentId, commit: before[2], cause: "dependency" },
    ]);
    expect(landing.rewrite.relanded).toEqual([]);
    expect(await commitsOf(workspace, branch, producer.baseCommit)).toEqual([landing.landed]);
    // Each one taken out is paused as a consumer of the corrected result: it waits for review.
    expect(await assignmentState(workspace, changer.assignmentId)).toBe("awaiting-review");
    expect(await assignmentState(workspace, user.assignmentId)).toBe("awaiting-review");
    // A result taken out is work that did not land, so nothing offers to remove its checkout (R3).
    await closeAttempt(workspace, producer, changer.attemptId);
    const removals = (await nextActions(workspace)).forAction("remove_worktree");
    expect(removals.map((one) => one.attemptId)).not.toContain(changer.attemptId);
    const kept = await removeAttempt(workspace, producer, changer.attemptId);
    expect(kept.exitCode).not.toBe(0);

    // Its acceptance, taken again, is an ordinary landing: a changed patch is an integration cycle.
    const next = await nextActions(workspace);
    expect(next.actions.find((one) => one.assignmentId === changer.assignmentId)).toMatchObject({
      action: "delegate_rework",
      command: "operator work rework",
    });
    const revision = await revisionOf(workspace, changer.assignmentId);
    const delegated = await delegateRework(workspace, changer, {
      revision,
      body: { reason: "integration", conflicts: [] },
    });
    expect(delegated.json.reason).toBe("rework_delegated");
    const again = await startRework(workspace, changer, {
      revision: delegated.json.data.revision,
      commit: null,
      worktreePath: `${workspace.root}/again`,
    });
    expect(again.baseCommit).toBe(landing.to);
    const relanded = await landResult(workspace, again, {
      text: lines({ 2: "fixed two", 5: "changed five" }),
      path: "docs/result.md",
    });
    expect(relanded.accepted.json.reason).toBe("assignment_accepted");
    expect(relanded.accepted.json.data.landing).toMatchObject({
      kind: "fast-forward",
      from: landing.to,
    });

    // The dependent kept an equal patch, so it lands on the tip with no new review.
    const waiting = { ...user, attemptId: user.attemptId };
    const accepted = await acceptProduction(workspace, waiting, {
      submissionId: used.submitted.json.data.submissionId,
      revision: await revisionOf(workspace, user.assignmentId),
    });
    expect(accepted.json.reason).toBe("assignment_accepted");
    expect(accepted.json.data.landing).toMatchObject({
      kind: "merge",
      from: relanded.accepted.json.data.landing.to,
    });
    expect(await patchOf(workspace, accepted.json.data.landing.to)).toBe(
      await patchOf(workspace, before[2] ?? ""),
    );
  });

  test("a later commit that fails the gate at its new place is taken out with its dependent", async () => {
    const workspace = await makeReviewWorkspace(fixtures, {
      maxActiveAgents: 8,
      gate: {
        $schema: "./node_modules/@fveracoechea/operator/gate.schema.json",
        commands: [
          {
            name: "quality",
            // Only the corrected result together with the notes fails.
            argv: ["sh", "-c", "! grep -q Every docs/result.md || ! test -f notes/notes.md"],
            timeoutSeconds: 30,
          },
        ],
      },
    });
    const producer = await startProducer(workspace, undefined, {
      dependents: [
        { ...NOTES, dependsOn: [], writePaths: ["notes/"] },
        { ...OTHER, dependsOn: [NOTES.key], writePaths: ["other/"] },
      ],
    });
    const branch = await branchOf(workspace);
    const first = await landResult(workspace, producer, {
      text: "# Result\n",
      path: "docs/result.md",
    });
    const notes = await startSibling(workspace, producer, NOTES.key);
    await landResult(workspace, notes, { text: "# Notes\n", path: "notes/notes.md" });
    const other = await startSibling(workspace, producer, OTHER.key);
    await landResult(workspace, other, { text: "# Other\n", path: "other/other.md" });
    const before = await commitsOf(workspace, branch, producer.baseCommit);

    const fixing = await correct(workspace, producer, first);
    const fixed = await landResult(workspace, fixing, {
      text: "# Result\n\nEvery record.\n",
      path: "docs/result.md",
    });

    expect(fixed.accepted.json.reason).toBe("assignment_accepted");
    const landing = fixed.accepted.json.data.landing;
    expect(landing.rewrite.takenOut).toEqual([
      { assignmentId: notes.assignmentId, commit: before[1], cause: "gate" },
      { assignmentId: other.assignmentId, commit: before[2], cause: "dependency" },
    ]);
    expect(await commitsOf(workspace, branch, producer.baseCommit)).toEqual([landing.landed]);
    expect(await assignmentState(workspace, notes.assignmentId)).toBe("awaiting-review");
  });

  test("an interrupted rewrite moves the branch once when a repeat settles it", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { maxActiveAgents: 8 });
    const { producer, notes, branch, first } = await threeLanded(workspace);
    const before = await commitsOf(workspace, branch, producer.baseCommit);
    const fixing = await correct(workspace, producer, first);
    const artifact = await commitArtifact(
      workspace,
      fixing,
      "# Result\n\nEvery record.\n",
      "docs/result.md",
    );
    const reviewed = await reviewOnly(workspace, fixing, artifact);
    const moves = async () =>
      (
        await Bun.$`git -C ${workspace.repo} reflog show --format=%H ${`refs/heads/${branch}`}`.text()
      )
        .trim()
        .split("\n").length;
    const movedBefore = await moves();
    // A lock file stops every ref write of Git, so the move fails after its intent is recorded.
    const lock = `${workspace.repo}/.git/refs/heads/${branch}.lock`;
    await Bun.write(lock, "");

    const stopped = await acceptProduction(workspace, fixing, reviewed);

    expect(stopped.json.reason).toBe("integration_branch_unread");
    expect(await tipOf(workspace, branch)).toBe(before[2] ?? "");
    const next = await nextActions(workspace);
    expect(
      next.actions.find(
        (one) => one.action === "settle_landing" && one.assignmentId === producer.assignmentId,
      ),
    ).toMatchObject({ command: "operator work accept" });
    // A checkout of a later result proves nothing while the rewrite moves its commit.
    await closeAttempt(workspace, producer, notes.attemptId);
    const held = await removeAttempt(workspace, producer, notes.attemptId);
    expect(held.json.blockers.map((one: { reason: string }) => one.reason)).toEqual([
      "rewrite_pending",
    ]);
    // A withdrawal of a result that the rewrite moves waits until the move is settled.
    const { plan } = await withdrawIssues(workspaceTarget(workspace), producer.ownerToken, {
      sourceKind: "specification",
      parent: 15,
      numbers: [1502],
    });
    const withdrawal = await Bun.file(`${workspace.repo}/${plan.json.data.planPath}`).json();
    expect(withdrawal.refusals).toContainEqual({
      reason: "withdrawal_effect_unsettled",
      key: issueKey(1502),
      assignmentId: notes.assignmentId,
      effect: "rewrite_intent",
      landingId: expect.any(String),
      pendingAssignmentId: producer.assignmentId,
    });

    await rm(lock);
    const settled = await acceptProduction(workspace, fixing, { ...reviewed, gate: false });

    expect(settled.json.reason).toBe("assignment_accepted");
    const after = await commitsOf(workspace, branch, producer.baseCommit);
    expect(settled.json.data.landing).toMatchObject({
      kind: "rewrite",
      from: before[2],
      to: after[2],
    });
    expect(await moves()).toBe(movedBefore + 1);
    expect((await nextActions(workspace)).names).not.toContain("settle_landing");
  });

  test("an integration cycle of a correction that fails the gate starts from the parent of the replaced commit", async () => {
    const workspace = await makeReviewWorkspace(fixtures, {
      maxActiveAgents: 8,
      gate: {
        $schema: "./node_modules/@fveracoechea/operator/gate.schema.json",
        // The correction fails at its own place, so it does not land.
        commands: [
          {
            name: "quality",
            argv: ["sh", "-c", "! grep -q Every docs/result.md"],
            timeoutSeconds: 30,
          },
        ],
      },
    });
    const { producer, first, branch } = await threeLanded(workspace);
    const landed = first.artifact.commit;
    const parent = (await Bun.$`git -C ${workspace.repo} rev-parse ${`${landed}^`}`.text()).trim();
    expect(await tipOf(workspace, branch)).not.toBe(parent);

    const fixing = await correct(workspace, producer, first);
    const artifact = await commitArtifact(
      workspace,
      fixing,
      "# Result\n\nEvery record.\n",
      "docs/result.md",
    );
    await reviewOnly(workspace, fixing, artifact);
    await passCandidateGate(workspace, fixing);
    const owed = (await nextActions(workspace)).actions.find(
      (one) => one.assignmentId === producer.assignmentId && one.action === "delegate_rework",
    );
    expect(owed?.detail).toContain("it starts from the parent of the replaced commit");

    const delegated = await delegateRework(workspace, fixing, {
      revision: await revisionOf(workspace, producer.assignmentId),
      body: { reason: "integration", conflicts: [] },
    });
    expect(delegated.json.reason).toBe("rework_delegated");
    const cycle = await startRework(workspace, fixing, {
      revision: delegated.json.data.revision,
      commit: null,
      worktreePath: `${workspace.root}/integration`,
    });

    // The cycle lands in the place of the replaced commit, so it starts on its parent, not the tip.
    expect(cycle.baseCommit).toBe(parent);
    const brief = await Bun.file(`${cycle.worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain(`Your worktree starts from the parent of ${landed} on ${branch}`);
  });

  test("a commit landed again by a rewrite passes cleanup, and the replaced commit stays", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { maxActiveAgents: 8 });
    const { producer, notes, first } = await threeLanded(workspace);
    const fixing = await correct(workspace, producer, first);
    const fixed = await landResult(workspace, fixing, {
      text: "# Result\n\nEvery record.\n",
      path: "docs/result.md",
    });
    expect(fixed.accepted.json.data.landing.kind).toBe("rewrite");

    await closeAttempt(workspace, producer, notes.attemptId);
    const proven = await removeAttempt(workspace, producer, notes.attemptId);
    expect(proven.json.blockers.map((one: { reason: string }) => one.reason)).toEqual([
      "approval_required",
      "approval_required",
    ]);

    // The replaced commit is on no branch now, so only the person removes its checkout (D3).
    await closeAttempt(workspace, producer, producer.attemptId);
    const replaced = await removeAttempt(workspace, producer, producer.attemptId);
    expect(replaced.json.blockers).toEqual([
      {
        reason: "unlanded_work",
        assignmentId: producer.assignmentId,
        cause: "replaced",
        commits: [first.artifact.commit],
      },
    ]);
  });
});

/** Ten numbered lines, with the named lines changed. */
function lines(changed: Record<number, string>): string {
  return Array.from({ length: 10 }, (_, index) => changed[index] ?? `line ${index}`)
    .join("\n")
    .concat("\n");
}

async function treeOf(workspace: Workspace, commit: string): Promise<string> {
  return (await Bun.$`git -C ${workspace.repo} rev-parse ${`${commit}^{tree}`}`.text()).trim();
}

/** Runs each gate run that one producer owes, in the order `crew next` offers them. */
async function gatedTrees(workspace: Workspace, producer: Producer): Promise<string[]> {
  const trees: string[] = [];
  for (let round = 0; round < 10; round += 1) {
    const owed = (await nextActions(workspace)).actions.find(
      (one) =>
        one.action === "run_gate" &&
        one.assignmentId === producer.assignmentId &&
        one.attemptId === null &&
        one.blocker === null,
    );
    if (owed === undefined) {
      return trees;
    }
    const started = await runJson(workspace, [
      "gate",
      "run",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--assignment",
      producer.assignmentId,
    ]);
    expect(started.json.reason).toBe("gate_run_started");
    trees.push(started.json.data.key.tree);
  }
  return trees;
}

async function tipOf(workspace: Workspace, branch: string): Promise<string> {
  return (await Bun.$`git -C ${workspace.repo} rev-parse ${`refs/heads/${branch}`}`.text()).trim();
}

async function frontierRow(workspace: Workspace, assignmentId: string) {
  const frontier = await runJson(workspace, ["work", "frontier"]);
  const all = Object.values(frontier.json.data).flatMap((one) =>
    Array.isArray(one)
      ? (one as Array<{ assignmentId: string; state: string; revision: number }>)
      : [],
  );
  return all.find((one) => one.assignmentId === assignmentId) ?? null;
}

async function assignmentState(workspace: Workspace, assignmentId: string) {
  return (await frontierRow(workspace, assignmentId))?.state ?? null;
}

async function revisionOf(workspace: Workspace, assignmentId: string): Promise<number> {
  return (await frontierRow(workspace, assignmentId))?.revision ?? 0;
}

/** Invalidates the first result and starts its correction where the cycle says. */
async function correct(
  workspace: Workspace,
  producer: Producer,
  first: Awaited<ReturnType<typeof landResult>>,
) {
  const invalidated = await invalidateResult(workspace, producer, {
    assignmentId: producer.assignmentId,
    revision: await revisionOf(workspace, producer.assignmentId),
    defect: DEFECT,
  });
  expect(invalidated.json.reason).toBe("result_invalidated");
  const fixing = await startRework(workspace, producer, {
    revision: invalidated.json.data.revision,
    commit: null,
    worktreePath: `${workspace.root}/fix`,
  });
  expect(fixing.baseCommit).toBe(first.artifact.commit);
  return fixing;
}

/** Submits and reviews one committed result, and leaves its acceptance to the test. */
async function reviewOnly(
  workspace: Workspace,
  producer: Producer,
  artifact: Awaited<ReturnType<typeof commitArtifact>>,
) {
  const submitted = await submit(
    workspace,
    producer,
    submissionBody(producer, artifact, { assignmentRevision: producer.assignmentRevision }),
  );
  const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit, {
    worktreePath: `${workspace.root}/reviewer-${crypto.randomUUID().slice(0, 8)}`,
  });
  await reportReview(
    workspace,
    reviewer,
    submitted.json.data.reviewId,
    reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
  );
  await acceptReview(workspace, producer, {
    reviewAssignmentId: submitted.json.data.reviewAssignmentId,
    attemptId: reviewer.attemptId,
    revision: reviewer.revision,
  });
  return {
    submissionId: submitted.json.data.submissionId as string,
    revision: submitted.json.data.revision as number,
  };
}

async function closeAttempt(workspace: Workspace, producer: Producer, attemptId: string) {
  return runJson(workspace, [
    "cleanup",
    "close",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--attempt",
    attemptId,
  ]);
}

async function removeAttempt(workspace: Workspace, producer: Producer, attemptId: string) {
  return runJson(workspace, [
    "cleanup",
    "remove",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--attempt",
    attemptId,
  ]);
}
