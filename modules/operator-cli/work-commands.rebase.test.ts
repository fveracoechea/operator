import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { finalBranch, reviewedResult, SIBLING, startSibling } from "./branch-review-fixture.ts";
import {
  acceptedOneCommit,
  addRemote,
  editPull,
  editState,
  plan as publishPlan,
  planAndApprove,
  pullsOf,
  apply as publishApply,
  publishStatus,
  SOURCE,
} from "./publish-fixture.ts";
import {
  acceptProduction,
  grantDirection,
  invalidateResult,
  makeReviewWorkspace,
  passCandidateGate,
  type Producer,
  startProducer,
  type Workspace,
} from "./review-cycle-fixture.ts";
import { readFake, withdrawIssues, workspaceTarget, writeFake } from "./source-fixture.ts";
import {
  githubCalls,
  headCommit,
  nextActions,
  requestId as request,
  runJson,
  workspaces,
} from "./workspace-fixture.ts";

// Each test reviews and lands results, moves the target, and gates the rebuilt branch.
setDefaultTimeout(180_000);

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

type ApprovalRequest = {
  action: string;
  targets: string[];
  scope: string;
  requestRevision: string;
};

/** Moves the target branch on the remote, as a merge of other work on GitHub would. */
async function moveTarget(workspace: Workspace, path: string, text: string): Promise<string> {
  await Bun.write(`${workspace.repo}/${path}`, text, { createPath: true });
  await Bun.$`git -C ${workspace.repo} add ${path}`.quiet();
  await Bun.$`git -C ${workspace.repo} -c user.email=t@example.com -c user.name=Person commit -q -m ${`upstream ${path}`}`.quiet();
  await Bun.$`git -C ${workspace.repo} push -q origin main`.quiet();
  return headCommit(workspace);
}

async function planRebase(workspace: Workspace, base: string) {
  return runJson(workspace, ["work", "rebase", "--source", SOURCE, "--base", base]);
}

async function applyRebase(
  workspace: Workspace,
  producer: Producer,
  options: { base: string; planRevision: string },
) {
  return runJson(workspace, [
    "work",
    "rebase",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--source",
    SOURCE,
    "--base",
    options.base,
    "--plan-revision",
    options.planRevision,
  ]);
}

async function grant(workspace: Workspace, producer: Producer, approval: ApprovalRequest) {
  const granted = await grantDirection(workspace, producer, { approval }, "Rebase onto main.");
  expect(granted.json.reason).toBe("approval_granted");
}

/** Runs the gate on each place of the rebase in order, as `work rebase` names each run. */
async function gateRebase(workspace: Workspace, producer: Producer, base: string) {
  const runs: Array<Awaited<ReturnType<typeof runJson>>> = [];
  for (let round = 0; round < 10; round += 1) {
    const ran = await runJson(workspace, [
      "gate",
      "run",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--source",
      SOURCE,
      "--base",
      base,
    ]);
    if (ran.json.reason !== "gate_run_started") {
      return { runs, last: ran };
    }
    runs.push(ran);
  }
  throw new Error("the rebase gate did not settle in ten runs");
}

function crewState(workspace: Workspace) {
  return new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`, { readonly: true });
}

function branchRow(workspace: Workspace) {
  const sqlite = crewState(workspace);
  try {
    return sqlite
      .query("select name, base_commit as base, recorded_tip as tip from integration_branches")
      .get() as { name: string; base: string; tip: string };
  } finally {
    sqlite.close();
  }
}

function landingStates(workspace: Workspace): Array<{ assignment: string; state: string }> {
  const sqlite = crewState(workspace);
  try {
    return sqlite
      .query("select assignment_id as assignment, state from landings order by created_at")
      .all() as Array<{ assignment: string; state: string }>;
  } finally {
    sqlite.close();
  }
}

function rebaseCount(workspace: Workspace): number {
  const sqlite = crewState(workspace);
  try {
    return (sqlite.query("select count(*) as n from integration_rebases").get() as { n: number }).n;
  } finally {
    sqlite.close();
  }
}

async function commitsOf(workspace: Workspace, branch: string, base: string): Promise<string[]> {
  const listed =
    await Bun.$`git -C ${workspace.repo} rev-list --reverse --first-parent ${`${base}..refs/heads/${branch}`}`.text();
  return listed.trim().split("\n").filter(Boolean);
}

async function patchOf(workspace: Workspace, commit: string): Promise<string> {
  return Bun.$`git -C ${workspace.repo} diff-tree -p --no-renames ${commit}^ ${commit}`.text();
}

async function branches(workspace: Workspace): Promise<string[]> {
  const format = "--format=%(refname)";
  return (await Bun.$`git -C ${workspace.repo} for-each-ref ${format} refs/heads/`.text())
    .trim()
    .split("\n");
}

async function frontierState(workspace: Workspace, assignmentId: string) {
  const frontier = await runJson(workspace, ["work", "frontier"]);
  const rows = Object.values(frontier.json.data).flatMap((one) =>
    Array.isArray(one) ? (one as Array<{ assignmentId: string; state: string }>) : [],
  );
  return rows.find((one) => one.assignmentId === assignmentId)?.state ?? null;
}

function blockerReasons(result: Awaited<ReturnType<typeof runJson>>): string[] {
  return (result.json.blockers ?? []).map((one: { reason: string }) => one.reason);
}

async function cleanupAttempt(
  workspace: Workspace,
  producer: Producer,
  step: "close" | "remove",
  attemptId: string,
) {
  return runJson(workspace, [
    "cleanup",
    step,
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--attempt",
    attemptId,
  ]);
}

/** One landed result, and a sibling item whose result is reviewed and not yet accepted. */
async function landedWithSibling(workspace: Workspace) {
  await addRemote(workspace);
  const producer = await startProducer(workspace, undefined, {
    dependents: [{ ...SIBLING, dependsOn: [], writePaths: ["notes/"] }],
  });
  const first = await reviewedResult(workspace, producer, {
    text: "# Result\n",
    worktree: "reviewer-first",
  });
  const accepted = await acceptProduction(workspace, producer, first);
  expect(accepted.json.reason).toBe("assignment_accepted");
  const sibling = await startSibling(workspace, producer);
  const notes = await reviewedResult(workspace, sibling, {
    text: "# Notes\n",
    path: "notes/notes.md",
    worktree: "reviewer-second",
  });
  return { producer, sibling, notes, revision: accepted.json.data.revision as number };
}

describe("operator work rebase moves the integration branch to a new base behind an approval", () => {
  test("it needs the approval of its plan revision, gates the new base and each commit, and moves the branch once", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { maxActiveAgents: 8 });
    await addRemote(workspace);
    const { producer, acceptedSecond } = await finalBranch(workspace);
    const first = acceptedSecond.json.data.branchReview;
    expect(first.round).toBe(1);
    const before = branchRow(workspace);
    const old = await commitsOf(workspace, before.name, before.base);
    expect(old).toHaveLength(2);
    const newBase = await moveTarget(workspace, "upstream.md", "# Upstream\n");

    const planned = await planRebase(workspace, newBase);

    expect(planned.json.reason).toBe("rebase_planned");
    const { planRevision, approval, planPath } = planned.json.data;
    expect(approval).toEqual({
      action: "integration-rebase",
      targets: [before.base, newBase],
      scope: SOURCE,
      requestRevision: planRevision,
    });
    // The Operator reads a summary with counts, and every commit is in the plan file (R5).
    expect(planned.json.data.counts).toEqual({ merged: 0, relanded: 2, takenOut: 0 });
    expect(planned.json.data).not.toHaveProperty("record");
    const text = await Bun.file(`${workspace.repo}/${planPath}`).text();
    for (const commit of old) {
      expect(text).toContain(commit);
    }

    // Without the approval of this exact revision, nothing moves.
    const unapproved = await applyRebase(workspace, producer, { base: newBase, planRevision });
    expect(unapproved.json.reason).toBe("approval_required");
    await grant(workspace, producer, { ...approval, requestRevision: "another-revision" });
    const elsewhere = await applyRebase(workspace, producer, { base: newBase, planRevision });
    expect(elsewhere.json.reason).toBe("approval_required");
    expect(branchRow(workspace)).toEqual(before);
    expect((await nextActions(workspace)).names).not.toContain("rebase_integration");

    await grant(workspace, producer, approval);
    const offered = (await nextActions(workspace)).of("rebase_integration");
    expect(offered.detail).toBe(
      `An integration-rebase approval of ${before.name} onto ${newBase} is recorded. Run the rebase: it moves the branch only after the new base and each commit that lands again passed the project gate, and it names the next gate run until then.`,
    );
    expect(offered.command).toBe(
      `operator work rebase --source ${SOURCE} --base ${newBase} --plan-revision ${planRevision}`,
    );
    // The new base is gated first, and the branch does not move before it passed.
    const ungated = await applyRebase(workspace, producer, { base: newBase, planRevision });
    expect(ungated.json.reason).toBe("gate_pending");
    expect(ungated.json.blockers[0]).toMatchObject({ commit: newBase, parent: null });
    expect(branchRow(workspace)).toEqual(before);
    const gated = await gateRebase(workspace, producer, newBase);
    // One run on the new base, and one on each commit that lands again.
    expect(gated.runs).toHaveLength(3);
    expect(gated.last.json.reason).toBe("gate_passed");

    const checkouts = [workspace.repo, producer.worktreePath];
    const status = () =>
      Promise.all(checkouts.map((one) => Bun.$`git -C ${one} status --porcelain`.text()));
    const untouched = await status();
    const heldBranches = await branches(workspace);
    const githubBefore = await githubCalls(workspace);

    const rebased = await applyRebase(workspace, producer, { base: newBase, planRevision });

    expect(rebased.json.reason).toBe("rebased");
    const after = branchRow(workspace);
    expect(after.base).toBe(newBase);
    expect(after.tip).toBe(rebased.json.data.to.tip);
    const rebuilt = await commitsOf(workspace, after.name, newBase);
    expect(rebuilt).toHaveLength(2);
    for (const [index, commit] of rebuilt.entries()) {
      expect(commit).not.toBe(old[index]);
      expect(await patchOf(workspace, commit)).toBe(await patchOf(workspace, old[index] ?? ""));
    }
    // The CLI moves a ref it built only from reviewed patches, and writes no file (R1, D5).
    expect(await status()).toEqual(untouched);
    // It deletes no branch (R3), and it writes nothing to GitHub, so nothing merges (R2).
    expect(await branches(workspace)).toEqual(heldBranches);
    const calls = (await githubCalls(workspace)).slice(githubBefore.length);
    expect(calls.filter((one) => !one.startsWith("GET "))).toEqual([]);
    // The new head needs a new branch review, which counts against the limit of three.
    expect(rebased.json.data.branchReview).toMatchObject({ headCommit: after.tip, round: 2 });
    const next = await nextActions(workspace);
    expect(next.names).not.toContain("rebase_integration");
    expect(next.names).not.toContain("settle_rebase");
    // A repeat with the used revision moves nothing again.
    const repeated = await applyRebase(workspace, producer, { base: newBase, planRevision });
    expect(repeated.json.reason).toBe("rebase_base_unchanged");
  });

  test("a failing new base is not recorded, and the refusal names the run", async () => {
    const workspace = await makeReviewWorkspace(fixtures, {
      gate: {
        $schema: "./node_modules/@fveracoechea/operator/gate.schema.json",
        commands: [
          { name: "quality", argv: ["sh", "-c", "! test -f broken.md"], timeoutSeconds: 30 },
        ],
      },
    });
    const { producer } = await acceptedOneCommit(workspace);
    const before = branchRow(workspace);
    const newBase = await moveTarget(workspace, "broken.md", "# Broken\n");
    const planned = await planRebase(workspace, newBase);
    expect(planned.json.reason).toBe("rebase_planned");
    const { planRevision, approval } = planned.json.data;
    await grant(workspace, producer, approval);

    const gated = await gateRebase(workspace, producer, newBase);
    expect(gated.runs).toHaveLength(1);
    const runId = gated.runs[0]?.json.data.runId;
    const refused = await applyRebase(workspace, producer, { base: newBase, planRevision });

    expect(refused.json.reason).toBe("gate_failed");
    expect(refused.json.blockers[0]).toMatchObject({
      commit: newBase,
      parent: null,
      runIds: [runId],
    });
    expect(branchRow(workspace)).toEqual(before);
    expect(rebaseCount(workspace)).toBe(0);
  });

  test("a commit whose patch changes on the new base is taken out and offered as an integration cycle", async () => {
    const lines = (changed: Record<number, string>) =>
      Array.from({ length: 10 }, (_, index) => changed[index] ?? `line ${index}`).join("\n") + "\n";
    const workspace = await makeReviewWorkspace(fixtures, {
      files: { "docs/result.md": lines({}) },
    });
    await addRemote(workspace);
    const producer = await startProducer(workspace);
    const reviewed = await reviewedResult(workspace, producer, {
      text: lines({ 5: "changed five" }),
      worktree: "reviewer",
    });
    const accepted = await acceptProduction(workspace, producer, reviewed);
    expect(accepted.json.reason).toBe("assignment_accepted");
    const landed = accepted.json.data.landing.to;
    // Two lines above the change: it merges cleanly, and the context lines of the patch change.
    const newBase = await moveTarget(workspace, "docs/result.md", lines({ 3: "upstream three" }));
    const planned = await planRebase(workspace, newBase);
    expect(planned.json.data.counts).toEqual({ merged: 0, relanded: 0, takenOut: 1 });
    const { planRevision, approval } = planned.json.data;
    await grant(workspace, producer, approval);
    await gateRebase(workspace, producer, newBase);

    const rebased = await applyRebase(workspace, producer, { base: newBase, planRevision });

    expect(rebased.json.reason).toBe("rebased");
    expect(rebased.json.data.record.takenOut).toEqual([
      expect.objectContaining({
        assignmentId: producer.assignmentId,
        commit: landed,
        cause: "patch-changed",
      }),
    ]);
    const after = branchRow(workspace);
    expect(after).toMatchObject({ base: newBase, tip: newBase });
    expect(await frontierState(workspace, producer.assignmentId)).toBe("awaiting-review");
    // Its acceptance, taken again, lands as another patch, so it is an integration cycle.
    const next = await nextActions(workspace);
    expect(next.actions.find((one) => one.assignmentId === producer.assignmentId)).toMatchObject({
      action: "delegate_rework",
      command: "operator work rework",
    });
  });

  test("an open published pull request refuses, and a commit whose pull request merged leaves the branch", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const { producer, commit } = await acceptedOneCommit(workspace);
    const published = await planAndApprove(workspace, producer);
    const applied = await publishApply(workspace, producer, published.planRevision);
    expect(applied.json.reason).toBe("published");
    const target = await headCommit(workspace);

    // A person merges the pull request with a merge commit, and the target moves.
    await Bun.$`git -C ${workspace.repo} -c user.email=t@example.com -c user.name=Person merge -q --no-ff -m ${"Merge pull request #1"} ${commit}`.quiet();
    await Bun.$`git -C ${workspace.repo} push -q origin main`.quiet();
    const merge = await headCommit(workspace);

    // Until a read records the merge, the pull request is open, and no rebase changes it.
    const open = await planRebase(workspace, merge);
    expect(open.json.reason).toBe("rebase_published_range");
    expect(open.json.data.planRevision).toBeNull();

    const state = await readFake(workspace.github);
    state.commits = {
      ...state.commits,
      [merge]: { sha: merge, parents: [{ sha: target }, { sha: commit }] },
    };
    await writeFake(workspace.github, state);
    const [pull] = state.pulls?.["fveracoechea/operator"] ?? [];
    await editPull(workspace, {
      state: "closed",
      merged: true,
      merge_commit_sha: merge,
      head: { ref: pull?.head.ref ?? "", label: pull?.head.label ?? "", sha: commit },
      base: { ref: "main" },
    });
    expect((await publishStatus(workspace, producer)).json.reason).toBe("publish_observed");

    const planned = await planRebase(workspace, merge);
    expect(planned.json.reason).toBe("rebase_planned");
    expect(planned.json.data.counts).toEqual({ merged: 1, relanded: 0, takenOut: 0 });
    const { planRevision, approval } = planned.json.data;
    await grant(workspace, producer, approval);
    await gateRebase(workspace, producer, merge);
    const before = branchRow(workspace);
    const rebased = await applyRebase(workspace, producer, { base: merge, planRevision });

    expect(rebased.json.reason).toBe("rebased");
    expect(branchRow(workspace)).toMatchObject({ base: merge, tip: merge });
    expect(landingStates(workspace)).toEqual([
      { assignment: producer.assignmentId, state: "merged" },
    ]);
    // The merged result still completes its ticket after the merge.
    expect((await nextActions(workspace)).forAction("record_tracker")).not.toHaveLength(0);

    // A rebase that moved the branch and stopped before its outcome is settled by a repeat.
    editState(workspace, [
      "update integration_rebases set state = 'intended', rebased_at = null",
      `update integration_branches set base_commit = '${before.base}', recorded_tip = '${before.tip}'`,
      "update landings set state = 'landed'",
    ]);
    const settle = (await nextActions(workspace)).of("settle_rebase");
    expect(settle.command).toBe(
      `operator work rebase --source ${SOURCE} --base ${merge} --plan-revision ${planRevision}`,
    );
    const settled = await applyRebase(workspace, producer, { base: merge, planRevision });
    expect(settled.json.reason).toBe("rebased");
    expect(branchRow(workspace)).toMatchObject({ base: merge, tip: merge });
    expect((await nextActions(workspace)).names).not.toContain("settle_rebase");
  });

  test("after a settled head_moved fault, a rebase and the next stack publication carry the commits and write nothing to the moved pull request", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const { producer } = await acceptedOneCommit(workspace);
    const first = await planAndApprove(workspace, producer);
    expect((await publishApply(workspace, producer, first.planRevision)).json.reason).toBe(
      "published",
    );
    const [published] = await pullsOf(workspace);
    // A person pushes a commit that no review read, and then accepts the fault as it stands.
    await editPull(workspace, {
      head: {
        ref: published?.head.ref ?? "",
        label: published?.head.label ?? "",
        sha: "2".repeat(40),
      },
    });
    const read = await publishStatus(workspace, producer);
    expect(read.json.blockers[0]).toMatchObject({ fault: "head_moved" });
    await grant(workspace, producer, read.json.blockers[0].settlement);
    // The settled fault ends the part, so a new stack publication is the path, after a rebase
    // when the target moved (#121).
    const ended = (await nextActions(workspace)).of("publish_stack");
    expect(ended.detail).toContain("operator work rebase");

    // The stopped pull request is still open, and the settled fault lets the rebase run.
    const newBase = await moveTarget(workspace, "upstream.md", "# Upstream\n");
    const planned = await planRebase(workspace, newBase);
    expect(planned.json.reason).toBe("rebase_planned");
    const { planRevision, approval } = planned.json.data;
    await grant(workspace, producer, approval);
    await gateRebase(workspace, producer, newBase);
    expect(
      (await applyRebase(workspace, producer, { base: newBase, planRevision })).json.reason,
    ).toBe("rebased");
    expect((await nextActions(workspace)).forAction("settle_publish")).toEqual([]);

    // The next publication carries the rebuilt commit. A person moved the head of the pull
    // request it replaces, so it plans no close: it only names that pull request (decision 21).
    const next = await publishPlan(workspace);
    expect(next.json.reason).toBe("publish_planned");
    expect(next.json.data.closes).toEqual([]);
    expect(next.json.data.headMoved).toEqual([published?.number]);
    expect(next.json.data.approval.targets).not.toContain(
      `fveracoechea/operator#${published?.number}`,
    );
    const planText = await Bun.file(`${workspace.repo}/${next.json.data.planPath}`).text();
    expect(planText).toContain(`#${published?.number} gets no write`);
    await grant(workspace, producer, next.json.data.approval);
    const githubBefore = await githubCalls(workspace);
    const applied = await publishApply(workspace, producer, next.json.data.planRevision);
    expect(applied.json.reason).toBe("published");
    const [replacement] = applied.json.data.pullRequests;
    expect(replacement.headName).toBe("operator/fveracoechea-operator-15/2/1");

    // The moved pull request gets no comment, no close, and no other write.
    const pulls = await pullsOf(workspace);
    const moved = pulls.find((one) => one.number === published?.number);
    expect(moved?.state).toBe("open");
    expect((await readFake(workspace.github)).comments[String(published?.number)] ?? []).toEqual(
      [],
    );
    const writes = (await githubCalls(workspace))
      .slice(githubBefore.length)
      .filter((one) => !one.startsWith("GET "));
    expect(writes.filter((one) => one.includes(`/${published?.number}`))).toEqual([]);
    // Nothing merges, and its branch stays on the remote (R2, R3).
    const after = await nextActions(workspace);
    expect(after.forAction("settle_publish")).toEqual([]);
    expect(after.waiting).toContain("stack_open");
  });

  test("a new base that is not on the fetched target refuses with no plan revision", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    await acceptedOneCommit(workspace);
    // A local commit above the target tip that the remote target never held.
    const local = (
      await Bun.$`git -C ${workspace.repo} commit-tree HEAD^{tree} -p HEAD -m local`.text()
    ).trim();

    const planned = await planRebase(workspace, local);

    expect(blockerReasons(planned)).toContain("rebase_base_not_on_target");
    expect(planned.json.data.planRevision).toBeNull();
  });

  test("a correction of a landed commit and a withdrawn landed commit each refuse the rebase", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { maxActiveAgents: 8 });
    const { producer, sibling, notes, revision } = await landedWithSibling(workspace);
    expect((await acceptProduction(workspace, sibling, notes)).json.reason).toBe(
      "assignment_accepted",
    );
    const newBase = await moveTarget(workspace, "upstream.md", "# Upstream\n");
    expect((await planRebase(workspace, newBase)).json.reason).toBe("rebase_planned");

    const invalidated = await invalidateResult(workspace, producer, {
      assignmentId: producer.assignmentId,
      revision,
      defect: {
        summary: "The accepted result drops every second record.",
        evidence: "docs/result.md:1",
        foundBy: "the person",
      },
    });
    expect(invalidated.json.reason).toBe("result_invalidated");
    const correcting = await planRebase(workspace, newBase);
    expect(blockerReasons(correcting)).toContain("rebase_correction_open");
    expect(correcting.json.data.planRevision).toBeNull();

    await withdrawIssues(workspaceTarget(workspace), producer.ownerToken, {
      sourceKind: "specification",
      parent: 15,
      numbers: [1502],
    });
    const withdrawn = await planRebase(workspace, newBase);
    expect(blockerReasons(withdrawn)).toContain("rebase_take_out_pending");
    expect(withdrawn.json.data.planRevision).toBeNull();
  });

  test("while a rebase has no recorded outcome, a landing and a cleanup refuse with rebase_pending", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { maxActiveAgents: 8 });
    const { producer, sibling, notes } = await landedWithSibling(workspace);
    await passCandidateGate(workspace, sibling);
    const before = branchRow(workspace);
    const newBase = await moveTarget(workspace, "upstream.md", "# Upstream\n");
    const planned = await planRebase(workspace, newBase);
    expect(planned.json.reason).toBe("rebase_planned");
    const { planRevision, approval } = planned.json.data;
    await grant(workspace, producer, approval);
    await gateRebase(workspace, producer, newBase);
    expect(
      (await applyRebase(workspace, producer, { base: newBase, planRevision })).json.reason,
    ).toBe("rebased");
    // The rebase recorded its intent and stopped before its outcome.
    editState(workspace, [
      "update integration_rebases set state = 'intended', rebased_at = null",
      `update integration_branches set base_commit = '${before.base}', recorded_tip = '${before.tip}'`,
    ]);

    const accepted = await acceptProduction(workspace, sibling, { ...notes, gate: false });
    expect(accepted.json.reason).toBe("rebase_pending");
    await cleanupAttempt(workspace, producer, "close", producer.attemptId);
    const removed = await cleanupAttempt(workspace, producer, "remove", producer.attemptId);
    expect(blockerReasons(removed)).toContain("rebase_pending");
  });
});
