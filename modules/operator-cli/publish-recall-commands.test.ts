import { afterEach, describe, expect, test as bunTest } from "bun:test";
import {
  acceptAssignment,
  acceptProduction,
  grantDirection,
  invalidateResult,
  makeReviewWorkspace,
  type Producer,
  type Workspace,
} from "./review-cycle-fixture.ts";
import {
  acceptedOneCommit,
  apply,
  correction,
  editPull,
  effectRowsOf,
  mergeOnGithub,
  plan,
  publishStatus,
  pullsOf,
  recordTracker,
  remoteRefs,
  REPOSITORY,
  restoreState,
  SOURCE,
  STATE_LOST_AFTER_PLAN,
} from "./publish-fixture.ts";
import { readFake, withdrawIssues, workspaceTarget } from "./source-fixture.ts";
import { setFault } from "./tracker-fixture.ts";
import { githubCalls, nextActions, requestId as request, runJson } from "./workspace-fixture.ts";
import { workspaces } from "./workspace-fixture.ts";

// Each test publishes, corrects, and publishes again through separate CLI processes.
// Each test states its own bound, because a process-wide default would set the bound of every
// file in the bun test process (#179).
function test(name: string, run: () => Promise<void> | void, timeoutMs = 300_000) {
  bunTest(name, run, timeoutMs);
}

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

const DEFECT = {
  summary: "The accepted result drops every second record.",
  evidence: "docs/result.md:1 and the failing rerun of bun test.",
  foundBy: "the person, on the pull request",
};

/** One accepted code result, published as a stack of one behind the approval of its plan. */
async function publishedOneCommit(
  workspace: Workspace,
  options: Parameters<typeof acceptedOneCommit>[1] = {},
) {
  const accepted = await acceptedOneCommit(workspace, options);
  const planned = await plan(workspace);
  expect(planned.json.reason).toBe("publish_planned");
  const granted = await grantDirection(
    workspace,
    accepted.producer,
    { approval: planned.json.data.approval },
    "Publish exactly this plan.",
  );
  expect(granted.json.reason).toBe("approval_granted");
  const published = await apply(workspace, accepted.producer, planned.json.data.planRevision);
  expect(published.json.reason).toBe("published");
  const [pull] = await pullsOf(workspace);
  await editPull(workspace, {
    head: {
      ...pull?.head,
      ref: pull?.head.ref ?? "",
      label: pull?.head.label ?? "",
      sha: accepted.commit,
    },
  });
  return { ...accepted, number: published.json.data.pullRequests[0].number as number };
}

async function recall(
  workspace: Workspace,
  producer: Producer,
  planRevision?: string,
  env: Record<string, string> = {},
) {
  return runJson(
    workspace,
    [
      "publish",
      "recall",
      ...(planRevision === undefined
        ? []
        : ["--request", request(), "--owner-token", producer.ownerToken]),
      "--source",
      SOURCE,
      ...(planRevision === undefined ? [] : ["--plan-revision", planRevision]),
    ],
    workspace.repo,
    env,
  );
}

/** Plans the recall, grants the approval its plan names, and applies it. */
async function recallApproved(workspace: Workspace, producer: Producer) {
  const planned = await recall(workspace, producer);
  expect(planned.json.reason).toBe("recall_planned");
  const granted = await grantDirection(
    workspace,
    producer,
    { approval: planned.json.data.approval },
    "Recall exactly this plan.",
  );
  expect(granted.json.reason).toBe("approval_granted");
  return {
    planned,
    applied: await recall(workspace, producer, planned.json.data.planRevision),
  };
}

/** The reasons a rebase plan onto the target tip refuses with, all at once. */
async function rebaseRefusals(workspace: Workspace): Promise<string[]> {
  const tip = (await Bun.$`git -C ${workspace.repo} rev-parse main`.text()).trim();
  const planned = await runJson(workspace, ["work", "rebase", "--source", SOURCE, "--base", tip]);
  return (planned.json.blockers ?? []).map((one: { reason: string }) => one.reason);
}

/** The state and revision of one assignment, as the frontier shows it. */
async function frontierRow(workspace: Workspace, assignmentId: string) {
  const frontier = await runJson(workspace, ["work", "frontier"]);
  const rows = Object.values(frontier.json.data).flatMap((one) =>
    Array.isArray(one)
      ? (one as Array<{ assignmentId: string; state: string; revision: number }>)
      : [],
  );
  return rows.find((one) => one.assignmentId === assignmentId) ?? null;
}

async function pullComments(workspace: Workspace, number: number): Promise<string[]> {
  return ((await readFake(workspace.github)).comments[String(number)] ?? []).map((one) => one.body);
}

describe("a defect in an open published range", () => {
  test("an invalidation offers the recall, and the rewrite refuses until the recall is done", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const published = await publishedOneCommit(workspace);
    const invalidated = await invalidateResult(workspace, published.producer, {
      assignmentId: published.producer.assignmentId,
      revision: published.revision,
      defect: DEFECT,
    });
    expect(invalidated.json.reason).toBe("result_invalidated");

    // An open pull request refuses a rebase until the recall (#122).
    expect(await rebaseRefusals(workspace)).toContain("rebase_published_range");

    const next = await nextActions(workspace);
    const offered = next.of("recall_stack");
    expect(offered).toMatchObject({ sourceId: SOURCE, blocker: "approval_required" });
    expect(offered.detail).toContain(`#${published.number}`);

    const fixed = await correction(
      workspace,
      published.producer,
      invalidated.json.data.revision as number,
    );
    const refused = await acceptProduction(workspace, fixed.fixing, { ...fixed, gate: false });
    expect(refused.json.reason).toBe("rewrite_published_range");
    expect(refused.json.blockers[0].pullRequest).toBe(published.number);

    const { planned, applied } = await recallApproved(workspace, published.producer);
    // The approval binds the recall plan revision, and its targets are the pull requests (D1).
    expect(planned.json.data.approval).toMatchObject({
      action: "stack-recall",
      scope: SOURCE,
      targets: [`${REPOSITORY}#${published.number}`],
      requestRevision: planned.json.data.planRevision,
    });
    // The report is a summary that points to the plan, which holds every comment verbatim (R5).
    expect(JSON.stringify(planned.json)).not.toContain(DEFECT.summary);
    expect(await Bun.file(`${workspace.repo}/${planned.json.data.planPath}`).text()).toContain(
      DEFECT.summary,
    );
    expect(applied.json.reason).toBe("stack_recalled");
    const [pull] = await pullsOf(workspace);
    expect(pull).toMatchObject({ draft: true, state: "open" });
    const [comment] = await pullComments(workspace, published.number);
    // The reason is rendered from the defect record, with no text of the Operator.
    expect(comment).toContain(DEFECT.summary);
    expect(comment).toContain(DEFECT.evidence);
    expect(comment).toContain("Do not merge it.");
    // A repeat reads GitHub first, so it writes no second comment.
    const again = await recall(workspace, published.producer, planned.json.data.planRevision);
    expect(again.json.reason).toBe("nothing_to_recall");
    expect(await pullComments(workspace, published.number)).toHaveLength(1);
    expect((await nextActions(workspace)).forAction("recall_stack")).toEqual([]);
    // A recalled draft is no longer open for a merge, so it no longer refuses a rebase.
    expect(await rebaseRefusals(workspace)).not.toContain("rebase_published_range");

    const accepted = await acceptProduction(workspace, fixed.fixing, fixed);
    expect(accepted.json.reason).toBe("assignment_accepted");
    expect(accepted.json.data.landing.kind).toBe("rewrite");

    // The next publication has a new number and new names, and closes the recalled pull request.
    const after = await nextActions(workspace);
    expect(after.of("publish_stack").blocker).toBe("approval_required");
    const second = await plan(workspace);
    expect(second.json.reason).toBe("publish_planned");
    expect(second.json.data.publication).toBe(2);
    expect(second.json.data.names).toEqual(["operator/fveracoechea-operator-15/2/1"]);
    expect(second.json.data.approval.targets).toContain(`${REPOSITORY}#${published.number}`);
    const granted = await grantDirection(
      workspace,
      published.producer,
      { approval: second.json.data.approval },
      "Publish exactly this plan.",
    );
    expect(granted.json.reason).toBe("approval_granted");
    const republished = await apply(workspace, published.producer, second.json.data.planRevision);
    expect(republished.json.reason).toBe("published");
    const replacement = republished.json.data.pullRequests[0].number as number;
    expect(replacement).not.toBe(published.number);
    const pulls = await pullsOf(workspace);
    const old = pulls.find((one) => one.number === published.number);
    // Operator closes it with no merge, and never merges.
    expect(old?.state).toBe("closed");
    expect(old?.merged ?? false).toBe(false);
    expect(pulls.find((one) => one.number === replacement)).toMatchObject({ state: "open" });
    // No branch is deleted: the remote still holds the name of the replaced pull request (R3).
    expect(await remoteRefs(published.bare)).toContain(
      "refs/heads/operator/fveracoechea-operator-15/1/1",
    );
    const pointer = (await pullComments(workspace, published.number)).at(-1);
    expect(pointer).toContain(
      `Stack publication 2 replaces this pull request: it starts at #${replacement}.`,
    );
  });
});

describe("the recall writes", () => {
  test("it needs its approval, and a repeat after a lost answer writes one comment", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const published = await publishedOneCommit(workspace);
    const invalidated = await invalidateResult(workspace, published.producer, {
      assignmentId: published.producer.assignmentId,
      revision: published.revision,
      defect: DEFECT,
    });
    expect(invalidated.json.reason).toBe("result_invalidated");
    const planned = await recall(workspace, published.producer);
    expect(planned.json.reason).toBe("recall_planned");
    const { planRevision } = planned.json.data;

    // With no `stack-recall` approval of this revision, GitHub gets no write.
    const callsBefore = (await githubCalls(workspace)).length;
    const unapproved = await recall(workspace, published.producer, planRevision);
    expect(unapproved.json.reason).toBe("approval_required");
    const writes = (await githubCalls(workspace))
      .slice(callsBefore)
      .filter((one) => !one.startsWith("GET "));
    expect(writes).toEqual([]);
    expect((await pullsOf(workspace))[0]?.draft ?? false).toBe(false);

    // The comment is written, and only its answer is lost.
    const granted = await grantDirection(
      workspace,
      published.producer,
      { approval: planned.json.data.approval },
      "Recall exactly this plan.",
    );
    expect(granted.json.reason).toBe("approval_granted");
    await setFault(workspace, "createComment", "applied-lost");
    const lost = await recall(workspace, published.producer, planRevision);
    expect(lost.json.reason).not.toBe("stack_recalled");
    expect(await pullComments(workspace, published.number)).toHaveLength(1);
    // The recall is recorded as an intent after the writes of the publish, and its lost answer
    // leaves it uncertain (#129). The key order of the intent is its identity.
    const [recorded] = effectRowsOf(workspace, "recall");
    const { comment, marker } = JSON.parse(recorded?.intent ?? "{}");
    expect(marker).toMatch(
      new RegExp(`^<!-- operator:stack-comment:v1 recall:[0-9a-f-]{36}:${published.number} -->$`),
    );
    expect(comment).toStartWith(
      "Operator recalled this pull request to a draft. Do not merge it.\n",
    );
    expect(comment).toEndWith(`\n\n${marker}\n`);
    const recallIntent = JSON.stringify({
      kind: "recall",
      repository: REPOSITORY,
      number: published.number,
      comment,
      marker,
      recall: planRevision,
    });
    expect(effectRowsOf(workspace, "recall")).toEqual([
      { position: 2, kind: "recall", intent: recallIntent, state: "uncertain" },
    ]);
    expect(effectRowsOf(workspace, "close")).toEqual([]);
    // The repeat reads the comments first and finds the marker, so it writes no second one.
    const repeated = await recall(workspace, published.producer, planRevision);
    expect(repeated.json.reason).toBe("stack_recalled");
    expect(await pullComments(workspace, published.number)).toHaveLength(1);
    expect(effectRowsOf(workspace, "recall")).toEqual([
      { position: 2, kind: "recall", intent: recallIntent, state: "done" },
    ]);
    expect((await pullsOf(workspace))[0]).toMatchObject({ draft: true, state: "open" });
  });

  test("a crew state that the approval read cannot find is reported as such, with no write", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const published = await publishedOneCommit(workspace);
    const invalidated = await invalidateResult(workspace, published.producer, {
      assignmentId: published.producer.assignmentId,
      revision: published.revision,
      defect: DEFECT,
    });
    expect(invalidated.json.reason).toBe("result_invalidated");
    const planned = await recall(workspace, published.producer);
    expect(planned.json.reason).toBe("recall_planned");
    const { planRevision } = planned.json.data;
    const granted = await grantDirection(
      workspace,
      published.producer,
      { approval: planned.json.data.approval },
      "Recall exactly this plan.",
    );
    expect(granted.json.reason).toBe("approval_granted");
    const callsBefore = (await githubCalls(workspace)).length;

    const lost = await recall(workspace, published.producer, planRevision, STATE_LOST_AFTER_PLAN);

    // The state failure is reported as it is, the same as a rebase does, not as a missing
    // approval, and GitHub gets no write.
    expect(lost.json.reason).toBe("state_missing");
    const writes = (await githubCalls(workspace))
      .slice(callsBefore)
      .filter((one) => !one.startsWith("GET "));
    expect(writes).toEqual([]);
    expect(await pullComments(workspace, published.number)).toEqual([]);
    await restoreState(workspace);
    const recalled = await recall(workspace, published.producer, planRevision);
    expect(recalled.json.reason).toBe("stack_recalled");
  });

  test("a pull request that merged before the write is a conflict, with no draft and no comment", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const published = await publishedOneCommit(workspace);
    const invalidated = await invalidateResult(workspace, published.producer, {
      assignmentId: published.producer.assignmentId,
      revision: published.revision,
      defect: DEFECT,
    });
    expect(invalidated.json.reason).toBe("result_invalidated");
    const planned = await recall(workspace, published.producer);
    const granted = await grantDirection(
      workspace,
      published.producer,
      { approval: planned.json.data.approval },
      "Recall exactly this plan.",
    );
    expect(granted.json.reason).toBe("approval_granted");
    // A person merges the pull request after the approval and before the write.
    await mergeOnGithub(workspace, { head: published.commit, method: "merge" });

    const applied = await recall(workspace, published.producer, planned.json.data.planRevision);

    expect(applied.json.reason).toBe("publish_conflict");
    expect(applied.json.blockers[0].settlement).toMatchObject({
      action: "stack-fault",
      targets: [`${REPOSITORY}#${published.number}`],
      scope: SOURCE,
    });
    expect((await pullsOf(workspace))[0]?.draft ?? false).toBe(false);
    expect(await pullComments(workspace, published.number)).toEqual([]);
  });
});

describe("a head that a person moved", () => {
  test("after the publish plan, the close of the recalled pull request writes nothing to it", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const published = await publishedOneCommit(workspace);
    const invalidated = await invalidateResult(workspace, published.producer, {
      assignmentId: published.producer.assignmentId,
      revision: published.revision,
      defect: DEFECT,
    });
    expect(invalidated.json.reason).toBe("result_invalidated");
    const fixed = await correction(
      workspace,
      published.producer,
      invalidated.json.data.revision as number,
    );
    expect((await recallApproved(workspace, published.producer)).applied.json.reason).toBe(
      "stack_recalled",
    );
    expect((await acceptProduction(workspace, fixed.fixing, fixed)).json.reason).toBe(
      "assignment_accepted",
    );
    const second = await plan(workspace);
    expect(second.json.data.closes).toEqual([published.number]);
    const granted = await grantDirection(
      workspace,
      published.producer,
      { approval: second.json.data.approval },
      "Publish exactly this plan.",
    );
    expect(granted.json.reason).toBe("approval_granted");
    // A person pushes to the recalled pull request after the approval.
    const [recalled] = await pullsOf(workspace);
    await editPull(workspace, {
      head: {
        ref: recalled?.head.ref ?? "",
        label: recalled?.head.label ?? "",
        sha: "3".repeat(40),
      },
    });

    const applied = await apply(workspace, published.producer, second.json.data.planRevision);

    expect(applied.json.reason).toBe("publish_conflict");
    const old = (await pullsOf(workspace)).find((one) => one.number === published.number);
    expect(old).toMatchObject({ state: "open" });
    // Only the recall comment is there: the close wrote no pointer and did not close it.
    expect(await pullComments(workspace, published.number)).toHaveLength(1);
  });
});

describe("a merge before the recall", () => {
  test("ends the change: it is a stack fault, and the recall is no longer offered", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const published = await publishedOneCommit(workspace);
    const invalidated = await invalidateResult(workspace, published.producer, {
      assignmentId: published.producer.assignmentId,
      revision: published.revision,
      defect: DEFECT,
    });
    expect(invalidated.json.reason).toBe("result_invalidated");
    expect((await nextActions(workspace)).of("recall_stack").blocker).toBe("approval_required");

    await mergeOnGithub(workspace, { head: published.commit, method: "merge" });
    const read = await publishStatus(workspace, published.producer);
    expect(read.json.reason).toBe("stack_fault");
    expect(read.json.blockers[0]).toMatchObject({
      number: published.number,
      fault: "merged_before_recall",
    });
    expect(read.json.blockers[0].detail).toContain("becomes a new issue");
    const next = await nextActions(workspace);
    expect(next.forAction("recall_stack")).toEqual([]);
    expect(next.of("settle_publish").blocker).toBe("stack_fault");
    const refused = await recall(workspace, published.producer);
    expect(refused.json.reason).toBe("nothing_to_recall");
  });

  test("a settled merge before the recall closes the invalidation with no correction, and the source finishes", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { maxActiveAgents: 8 });
    const published = await publishedOneCommit(workspace, {
      dependents: [
        { key: "22.2", kind: "planning", title: "Decide the follow-up", dependsOn: ["22.1"] },
      ],
    });
    const { producer } = published;
    // A dependent that consumed the result pauses at the invalidation.
    const dependent = producer.dependents.get("22.2") ?? "";
    const decided = await acceptAssignment(workspace, producer, {
      assignmentId: dependent,
      revision: (await frontierRow(workspace, dependent))?.revision ?? 0,
    });
    expect(decided.json.reason).toBe("assignment_accepted");
    const invalidated = await invalidateResult(workspace, producer, {
      assignmentId: producer.assignmentId,
      revision: published.revision,
      defect: DEFECT,
    });
    expect(invalidated.json.reason).toBe("result_invalidated");
    expect((await frontierRow(workspace, dependent))?.state).toBe("paused");
    await mergeOnGithub(workspace, { head: published.commit, method: "merge" });
    const read = await publishStatus(workspace, producer);
    expect(read.json.blockers[0]).toMatchObject({ fault: "merged_before_recall" });

    const granted = await grantDirection(
      workspace,
      producer,
      { approval: read.json.blockers[0].settlement },
      "The merge stands. The defect becomes a new issue.",
    );
    expect(granted.json.reason).toBe("approval_granted");

    // The merged commit is never corrected: the invalidation closes with no correction, the
    // result counts as landed, and its dependent returns to the state it was paused from.
    const next = await nextActions(workspace);
    expect(
      next
        .forAction("claim_assignment")
        .filter((one) => one.assignmentId === producer.assignmentId),
    ).toEqual([]);
    expect(next.forAction("settle_publish")).toEqual([]);
    expect(next.names).not.toContain("recall_stack");
    const row = await frontierRow(workspace, producer.assignmentId);
    expect(row?.state).toBe("accepted");
    expect((await frontierRow(workspace, dependent))?.state).toBe("accepted");
    // The tracker steps of the merged pull request run, so the source can finish.
    const resolved = await recordTracker(workspace, producer, {
      revision: row?.revision ?? 0,
      input: { step: "resolution" },
    });
    expect(resolved.json.reason).toBe("tracker.completed");
    const completed = await recordTracker(workspace, producer, {
      revision: row?.revision ?? 0,
      input: { step: "completion", reason: "completed" },
    });
    expect(completed.json.reason).toBe("tracker.completed");
    expect(completed.json.data.finish.status).toBe("finished");
  });

  test("a merged commit is never invalidated", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const published = await publishedOneCommit(workspace);
    await mergeOnGithub(workspace, { head: published.commit, method: "merge" });
    expect((await publishStatus(workspace, published.producer)).json.reason).toBe(
      "publish_observed",
    );
    const refused = await invalidateResult(workspace, published.producer, {
      assignmentId: published.producer.assignmentId,
      revision: published.revision,
      defect: DEFECT,
    });
    expect(refused.json.reason).toBe("invalidation_merged");
    expect(refused.json.blockers[0]).toMatchObject({
      pullRequest: published.number,
      commit: published.commit,
    });
  });
});

describe("a withdrawal after publish", () => {
  test("of the last code item closes the recalled pull request with the withdrawal comment", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    // A planning item stays, so the source keeps an item after its one code item is withdrawn.
    const published = await publishedOneCommit(workspace, {
      dependents: [{ key: "22.2", kind: "planning", title: "Decide the follow-up", dependsOn: [] }],
    });
    const { plan: withdrawal } = await withdrawIssues(
      workspaceTarget(workspace),
      published.producer.ownerToken,
      { sourceKind: "specification", parent: 15, numbers: [1501] },
    );
    const takeOutRevision = withdrawal.json.data.planRevision as string;
    const takeOut = () =>
      runJson(workspace, [
        "work",
        "take-out",
        "--request",
        request(),
        "--owner-token",
        published.producer.ownerToken,
        "--source",
        SOURCE,
        "--plan-revision",
        takeOutRevision,
      ]);
    // The take-out refuses and names the pull request until the recall is done.
    const early = await takeOut();
    expect(early.json.reason).toBe("rewrite_published_range");
    expect((await nextActions(workspace)).of("recall_stack").detail).toContain("closes it");

    const { planned, applied } = await recallApproved(workspace, published.producer);
    expect(planned.json.data.replaced).toBe(false);
    expect(applied.json.reason).toBe("stack_recalled");
    expect(applied.json.data.closed).toBe(true);
    const [pull] = await pullsOf(workspace);
    expect(pull).toMatchObject({ state: "closed", draft: true });
    expect(pull?.merged ?? false).toBe(false);
    const comments = await pullComments(workspace, published.number);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain(`${REPOSITORY}#1501`);
    expect(comments[0]).toContain("is withdrawn");
    expect(comments[0]).toContain("no new stack publication replaces this pull request");

    const taken = await takeOut();
    expect(taken.json.reason).toBe("commits_taken_out");
    expect((await nextActions(workspace)).forAction("publish_stack")).toEqual([]);
  });
});

test("the publish skill topic describes the recall", async () => {
  const topic = await Bun.file(`${import.meta.dir}/../../skills/operator/PUBLISH.md`).text();
  expect(topic).toContain("## Recall");
  expect(topic).toContain("bun run operator publish recall --source <source id> --json");
  expect(topic).toContain("action `stack-recall`");
  expect(topic).toContain("renders from the defect or the withdrawal record");
  expect(topic).toContain("`merged_before_recall`");
});
