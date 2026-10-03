import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  branchReport,
  finalBranch,
  type Registered,
  startBranchReviewer,
} from "./branch-review-fixture.ts";
import { Database } from "bun:sqlite";
import {
  acceptProduction,
  acceptReview,
  invalidateResult,
  makeReviewWorkspace,
  type Producer,
  PUBLISHED_TEXT,
  reportReview,
  type Workspace,
} from "./review-cycle-fixture.ts";
import {
  addRemote,
  apply,
  correction,
  editState,
  grant,
  normalized,
  plan,
  planAndApprove,
  publishStatus,
  pullsOf,
  reasons,
  remoteRefs,
  REPOSITORY,
  SOURCE,
} from "./publish-fixture.ts";
import type { FakePull } from "./github-fake-state.ts";
import { readFake, writeFake } from "./source-fixture.ts";
import {
  githubCalls,
  nextActions,
  requestId as request,
  runJson,
  workspaces,
} from "./workspace-fixture.ts";

// Each test runs three producers, their reviewers, a branch reviewer, and gate runs.
setDefaultTimeout(300_000);

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

const NAMES = [
  "operator/fveracoechea-operator-15/1/1",
  "operator/fveracoechea-operator-15/1/2",
  "operator/fveracoechea-operator-15/1/3",
] as const;

const PART_TWO = {
  reason: "The notes are a second topic, and they read only what part 1 lands.",
  title: "Write the notes of the result",
  summary: "Adds the notes that name the result.",
  startHere: "Read notes/notes.md first.",
  mergeDanger: "Nothing known: the change adds one file.",
};

const PART_THREE = {
  reason: "The extra file is independent of the notes, so it reviews on its own.",
  title: "Write the extra file",
  summary: "Adds the extra file.",
  startHere: "Read extra/extra.md first.",
  mergeDanger: "Nothing known: the change adds one file.",
};

/**
 * A source of three reviewed commits whose branch reviewer cut it after the first and the second
 * commit. The cuts arrive in the report, so the Operator writes none of them (D1, R1).
 */
async function reviewedStack(
  workspace: Workspace,
  cutsOf: (commits: string[]) => unknown[] = (commits) => [
    { after: commits[0], ...PART_TWO },
    { after: commits[1], ...PART_THREE },
  ],
) {
  const bare = await addRemote(workspace);
  const final = await finalBranch(workspace, { third: "accepted" });
  const registered = final.acceptedSecond.json.data.branchReview as Registered;
  const commits = (
    await Bun.$`git -C ${workspace.repo} rev-list --reverse ${final.acceptedFirst.json.data.landing.from}..${registered.headCommit}`.quiet()
  ).stdout
    .toString()
    .trim()
    .split("\n");
  expect(commits).toHaveLength(3);
  const reviewer = await startBranchReviewer(
    workspace,
    final.producer,
    registered,
    "branch-reviewer",
  );
  const report = branchReport(workspace, registered.snapshotIdentity, [], {
    observedChecks: [{ name: "true", outcome: "passed" }],
  });
  const reported = await reportReview(workspace, reviewer, registered.reviewId, {
    ...report,
    published: { ...PUBLISHED_TEXT, cuts: cutsOf(commits) },
  });
  return { bare, final, registered, reviewer, commits, reported };
}

/** A stack whose branch review reported and was accepted, so the plan has no refusal. */
async function acceptedStack(workspace: Workspace) {
  const stack = await reviewedStack(workspace);
  expect(stack.reported.json.reason).toBe("review_reported");
  const freed = await acceptReview(workspace, stack.final.producer, {
    reviewAssignmentId: stack.registered.assignmentId,
    attemptId: stack.reviewer.attemptId,
    revision: stack.reviewer.revision,
  });
  expect(freed.json.reason).toBe("assignment_accepted");
  return stack;
}

/** A published stack of three, with the head GitHub shows for each part set to its commit. */
async function publishedStack(workspace: Workspace) {
  const stack = await acceptedStack(workspace);
  const approved = await planAndApprove(workspace, stack.final.producer);
  const published = await apply(workspace, stack.final.producer, approved.planRevision);
  expect(published.json.reason).toBe("published");
  const state = await readFake(workspace.github);
  state.pulls = {
    ...state.pulls,
    [REPOSITORY]: (state.pulls?.[REPOSITORY] ?? []).map((pull, index) => ({
      ...pull,
      head: { ...pull.head, sha: stack.commits[index] ?? "" },
    })),
  };
  await writeFake(workspace.github, state);
  const numbers = (published.json.data.pullRequests as Array<{ number: number }>).map(
    (one) => one.number,
  );
  return { ...stack, approved, numbers, producer: stack.final.producer };
}

async function changePull(workspace: Workspace, number: number, change: Partial<FakePull>) {
  const state = await readFake(workspace.github);
  state.pulls = {
    ...state.pulls,
    [REPOSITORY]: (state.pulls?.[REPOSITORY] ?? []).map((pull) =>
      pull.number === number ? { ...pull, ...change } : pull,
    ),
  };
  await writeFake(workspace.github, state);
}

/** Merges one part on the fake as a person does on GitHub, by a merge commit or a squash. */
async function mergePart(
  workspace: Workspace,
  options: { number: number; head: string; method: "merge" | "squash" },
) {
  const mergeCommit = new Bun.CryptoHasher("sha1").update(crypto.randomUUID()).digest("hex");
  const state = await readFake(workspace.github);
  const tip = "1".repeat(40);
  state.commits = {
    ...state.commits,
    [mergeCommit]: {
      sha: mergeCommit,
      parents: options.method === "merge" ? [{ sha: tip }, { sha: options.head }] : [{ sha: tip }],
    },
  };
  await writeFake(workspace.github, state);
  await changePull(workspace, options.number, {
    state: "closed",
    merged: true,
    merge_commit_sha: mergeCommit,
  });
}

/** The recorded publish approval of the stack, which a revoke names by its revision. */
function publishApprovalOf(workspace: Workspace): { id: string; revision: number } {
  const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`, {
    readonly: true,
  });
  try {
    const row = sqlite
      .query<{ id: string; revision: number }, []>(
        "select id, revision from approvals where action = 'publish' and state = 'granted'",
      )
      .get();
    if (row === null) {
      throw new Error("no publish approval is granted");
    }
    return row;
  } finally {
    sqlite.close();
  }
}

async function retarget(workspace: Workspace, producer: Producer, part: number) {
  return runJson(workspace, [
    "publish",
    "retarget",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--source",
    SOURCE,
    "--part",
    String(part),
  ]);
}

describe("a stack of more than one part", () => {
  test("two cut points create three pull requests, bottom up, each based on the one below it", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const stack = await acceptedStack(workspace);

    const planned = await plan(workspace);
    expect(planned.json.reason).toBe("publish_planned");
    expect(planned.json.data.names).toEqual(NAMES);
    expect(planned.json.data.approval.targets).toEqual([
      ...NAMES,
      "main",
      "github:fveracoechea/operator#1501:resolution",
      "github:fveracoechea/operator#1501:completion",
      "github:fveracoechea/operator#1502:resolution",
      "github:fveracoechea/operator#1502:completion",
      "github:fveracoechea/operator#1503:resolution",
      "github:fveracoechea/operator#1503:completion",
    ]);
    // The person reads each cut point with its reason before the approval binds them.
    const text = await Bun.file(`${workspace.repo}/${planned.json.data.planPath}`).text();
    expect(text).toContain(`Cut after ${stack.commits[0]}: ${PART_TWO.reason}`);
    expect(text).toContain(`Cut after ${stack.commits[1]}: ${PART_THREE.reason}`);

    const granted = await grant(workspace, stack.final.producer, planned.json.data.approval);
    expect(granted.json.reason).toBe("approval_granted");
    const published = await apply(workspace, stack.final.producer, planned.json.data.planRevision);
    expect(published.json.reason).toBe("published");

    const pulls = await pullsOf(workspace);
    expect(pulls.map((one) => [one.head.ref, one.base.ref, one.title])).toEqual([
      [NAMES[0], "main", PUBLISHED_TEXT.title],
      [NAMES[1], NAMES[0], PART_TWO.title],
      [NAMES[2], NAMES[1], PART_THREE.title],
    ]);
    // Bottom up: each body names the number of the part below, recorded by its create.
    const [first, second, third] = pulls.map((one) => one.number);
    expect((first ?? 0) < (second ?? 0) && (second ?? 0) < (third ?? 0)).toBe(true);
    expect(pulls[1]?.body).toContain(`Based on #${first}. Merge #${first} first.`);
    expect(pulls[2]?.body).toContain(`Based on #${second}. Merge #${second} first.`);
    for (const [index, pull] of pulls.entries()) {
      expect(normalized(pull.body)).toBe(
        await Bun.file(`${import.meta.dir}/publish-stack-body-${index + 1}.fixture.md`).text(),
      );
    }

    const refs = await remoteRefs(stack.bare);
    stack.commits.forEach((commit, index) => {
      expect(refs).toContain(`refs/heads/${NAMES[index]} ${commit}`);
    });
  });

  test("a cut point inside one commit refuses, in the report and in the plan", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const outside = "f".repeat(40);
    const stack = await reviewedStack(workspace, (commits) => [
      { after: outside, ...PART_TWO },
      { after: commits[2], ...PART_THREE },
    ]);
    expect(stack.reported.json.reason).toBe("review_cut_not_between_commits");
    expect(stack.reported.json.blockers[0].cuts).toEqual([outside, stack.commits[2]]);
    // Cuts out of order refuse too, because each part holds the commits between two cuts.
    const unordered = await reportReview(workspace, stack.reviewer, stack.registered.reviewId, {
      ...branchReport(workspace, stack.registered.snapshotIdentity, [], {
        observedChecks: [{ name: "true", outcome: "passed" }],
      }),
      published: {
        ...PUBLISHED_TEXT,
        cuts: [
          { after: stack.commits[1], ...PART_TWO },
          { after: stack.commits[0], ...PART_THREE },
        ],
      },
    });
    expect(unordered.json.reason).toBe("review_cut_not_between_commits");

    // A text an earlier report recorded is refused by the plan, in the order of decision 10.
    const good = await reportReview(
      workspace,
      stack.reviewer,
      stack.registered.reviewId,
      branchReport(workspace, stack.registered.snapshotIdentity, [], {
        observedChecks: [{ name: "true", outcome: "passed" }],
      }),
    );
    expect(good.json.reason).toBe("review_reported");
    const bad = JSON.stringify({ ...PUBLISHED_TEXT, cuts: [{ after: outside, ...PART_TWO }] });
    editState(workspace, [
      `update reviews set published_text = '${bad.replaceAll("'", "''")}' where id = '${stack.registered.reviewId}'`,
    ]);
    const refused = await plan(workspace);
    expect(refused.json.reason).toBe("publish_refused");
    expect(reasons(refused)).toContain("cut_not_between_commits");
  });

  test("after part 1 merges, crew next offers the retarget of part 2, and a done retarget writes nothing", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const stack = await publishedStack(workspace);
    const [first = 0, second = 0, third = 0] = stack.numbers;

    expect((await nextActions(workspace)).forAction("retarget_pull_request")).toEqual([]);
    const early = await retarget(workspace, stack.producer, 2);
    expect(early.json.reason).toBe("retarget_not_due");

    await mergePart(workspace, { number: first, head: stack.commits[0] ?? "", method: "merge" });
    const read = await publishStatus(workspace, stack.producer);
    expect(read.json.reason).toBe("publish_observed");
    const next = await nextActions(workspace);
    expect(next.forAction("retarget_pull_request")).toEqual([
      expect.objectContaining({ sourceId: SOURCE, blocker: null }),
    ]);
    expect(next.of("retarget_pull_request").command).toContain("--part 2");

    const callsBefore = (await githubCalls(workspace)).length;
    const changed = await retarget(workspace, stack.producer, 2);
    expect(changed.json.reason).toBe("pull_request_retargeted");
    expect(changed.json.data).toMatchObject({ part: 2, number: second, how: "written" });
    const pulls = await pullsOf(workspace);
    expect(pulls.find((one) => one.number === second)?.base.ref).toBe("main");
    expect(pulls.find((one) => one.number === third)?.base.ref).toBe(NAMES[1]);
    // The retarget changes the base and nothing else: no merge, no auto-merge (R2, D6).
    const calls = (await githubCalls(workspace)).slice(callsBefore);
    expect(calls).toContain(`PATCH repos/${REPOSITORY}/pulls/${second}`);
    for (const call of calls) {
      expect(call).toMatch(/^(GET|PATCH) repos\/fveracoechea\/operator\/pulls\/\d+$/);
    }
    expect((await nextActions(workspace)).forAction("retarget_pull_request")).toEqual([]);

    // GitHub already changed the base of part 3, so its retarget reads and writes nothing.
    await mergePart(workspace, { number: second, head: stack.commits[1] ?? "", method: "merge" });
    await changePull(workspace, third, { base: { ref: "main" } });
    await publishStatus(workspace, stack.producer);
    expect((await nextActions(workspace)).of("retarget_pull_request").command).toContain(
      "--part 3",
    );
    const before = (await githubCalls(workspace)).length;
    const observed = await retarget(workspace, stack.producer, 3);
    expect(observed.json.reason).toBe("pull_request_retargeted");
    expect(observed.json.data).toMatchObject({ part: 3, number: third, how: "observed" });
    for (const call of (await githubCalls(workspace)).slice(before)) {
      expect(call).toMatch(/^GET /);
    }
  });

  test("a part whose head a person moved gets no retarget after the part below merges", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const stack = await publishedStack(workspace);
    const [first = 0, second = 0] = stack.numbers;

    await mergePart(workspace, { number: first, head: stack.commits[0] ?? "", method: "merge" });
    const moved = (await pullsOf(workspace)).find((one) => one.number === second);
    if (moved === undefined) {
      throw new Error("the fake holds no part 2");
    }
    await changePull(workspace, second, { head: { ...moved.head, sha: "e".repeat(40) } });
    const read = await publishStatus(workspace, stack.producer);
    expect(read.json.reason).toBe("stack_fault");

    // The Operator writes nothing more to a pull request whose head a person moved (decision 21).
    expect((await nextActions(workspace)).forAction("retarget_pull_request")).toEqual([]);
    const callsBefore = (await githubCalls(workspace)).length;
    const refused = await retarget(workspace, stack.producer, 2);
    expect(refused.json.reason).toBe("stack_fault");
    for (const call of (await githubCalls(workspace)).slice(callsBefore)) {
      expect(call).not.toMatch(/^PATCH /);
    }
  });

  test("a retarget with no publish approval writes nothing", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const stack = await publishedStack(workspace);
    const [first = 0] = stack.numbers;
    await mergePart(workspace, { number: first, head: stack.commits[0] ?? "", method: "merge" });
    expect((await publishStatus(workspace, stack.producer)).json.reason).toBe("publish_observed");

    const approval = publishApprovalOf(workspace);
    const revoked = await runJson(workspace, [
      "approval",
      "revoke",
      "--request",
      request(),
      "--owner-token",
      stack.producer.ownerToken,
      "--approval",
      approval.id,
      "--revision",
      String(approval.revision),
    ]);
    expect(revoked.json.reason).toBe("approval_revoked");

    expect((await nextActions(workspace)).of("retarget_pull_request").blocker).toBe(
      "approval_required",
    );
    const callsBefore = (await githubCalls(workspace)).length;
    const refused = await retarget(workspace, stack.producer, 2);
    expect(refused.json.reason).toBe("approval_required");
    for (const call of (await githubCalls(workspace)).slice(callsBefore)) {
      expect(call).not.toMatch(/^PATCH /);
    }
  });

  test("a fault on part 1 stops the retarget of every part above it", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const stack = await publishedStack(workspace);
    const [first = 0] = stack.numbers;

    // Parts 2 and 3 stay open with no fault of their own.
    await mergePart(workspace, { number: first, head: stack.commits[0] ?? "", method: "squash" });
    const read = await publishStatus(workspace, stack.producer);
    expect(read.json.reason).toBe("stack_fault");

    const next = await nextActions(workspace);
    expect(next.forAction("retarget_pull_request")).toEqual([]);
    expect(next.of("settle_publish")).toMatchObject({ sourceId: SOURCE, blocker: "stack_fault" });
    expect(next.of("settle_publish").detail).toContain("part 2 and part 3 are stopped");

    const callsBefore = (await githubCalls(workspace)).length;
    for (const part of [2, 3]) {
      const refused = await retarget(workspace, stack.producer, part);
      expect(refused.json.reason).toBe("stack_fault");
    }
    for (const call of (await githubCalls(workspace)).slice(callsBefore)) {
      expect(call).not.toMatch(/^PATCH /);
    }
  });
});

/** The recorded revision of one assignment, which a mutation on it states. */
function revisionOf(workspace: Workspace, assignmentId: string): number {
  const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`, {
    readonly: true,
  });
  try {
    return (
      sqlite
        .query<{ revision: number }, [string]>("select revision from assignments where id = ?")
        .get(assignmentId)?.revision ?? 0
    );
  } finally {
    sqlite.close();
  }
}

async function recall(workspace: Workspace, producer: Producer, planRevision?: string) {
  return runJson(workspace, [
    "publish",
    "recall",
    ...(planRevision === undefined
      ? []
      : ["--request", request(), "--owner-token", producer.ownerToken]),
    "--source",
    SOURCE,
    ...(planRevision === undefined ? [] : ["--plan-revision", planRevision]),
  ]);
}

describe("a change after publish", () => {
  test("a recall makes drafts from the affected part up and leaves the parts below open", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const stack = await publishedStack(workspace);
    const [first = 0, second = 0, third = 0] = stack.numbers;
    const sibling = stack.final.sibling;
    const invalidated = await invalidateResult(workspace, stack.producer, {
      assignmentId: sibling.assignmentId,
      revision: revisionOf(workspace, sibling.assignmentId),
      defect: {
        summary: "The notes name the wrong result.",
        evidence: "notes/notes.md:1",
        foundBy: "the person, on the pull request",
      },
    });
    expect(invalidated.json.reason).toBe("result_invalidated");

    const offered = (await nextActions(workspace)).of("recall_stack");
    expect(offered.blocker).toBe("approval_required");
    const planned = await recall(workspace, stack.producer);
    expect(planned.json.data.pullRequests).toEqual([second, third]);
    expect(planned.json.data.approval.targets).toEqual([
      `${REPOSITORY}#${second}`,
      `${REPOSITORY}#${third}`,
    ]);
    const granted = await grant(workspace, stack.producer, planned.json.data.approval);
    expect(granted.json.reason).toBe("approval_granted");
    const callsBefore = (await githubCalls(workspace)).length;
    const applied = await recall(workspace, stack.producer, planned.json.data.planRevision);
    expect(applied.json.reason).toBe("stack_recalled");
    expect(applied.json.data).toMatchObject({ pullRequests: [second, third], closed: false });

    const pulls = await pullsOf(workspace);
    expect(pulls.map((one) => [one.number, one.state, one.draft])).toEqual([
      [first, "open", false],
      [second, "open", true],
      [third, "open", true],
    ]);
    const comments = (await readFake(workspace.github)).comments;
    expect(comments[String(first)]).toBeUndefined();
    for (const number of [second, third]) {
      expect(comments[String(number)]?.map((one) => one.body)).toEqual([
        expect.stringContaining("The notes name the wrong result."),
      ]);
    }
    // The recall never merges, never closes, and never changes a base (R2, D6).
    for (const call of (await githubCalls(workspace)).slice(callsBefore)) {
      expect(call).toMatch(/^(GET repos\/|POST graphql|POST repos\/.*\/issues\/\d+\/comments)/);
    }

    // The part below stays open, so the stack still waits on its merge.
    await publishStatus(workspace, stack.producer);
    const next = await nextActions(workspace);
    expect(next.forAction("recall_stack")).toEqual([]);
    expect(next.waits.find((one) => one.wait === "stack_open")?.detail).toContain(`#${first}`);
    expect(next.waits.find((one) => one.wait === "stack_open")?.detail).not.toContain(`#${second}`);

    // The correction lands on the local branch, and the rewrite lands the third commit again.
    const fixed = await correction(workspace, sibling, invalidated.json.data.revision as number, {
      path: "notes/notes.md",
      text: "# Notes\n\nThe right result.\n",
      worktree: "fix-notes",
    });
    const corrected = await acceptProduction(workspace, fixed.fixing, fixed);
    expect(corrected.json.reason).toBe("assignment_accepted");
    // Part 1 stays open below the recalled parts, so a new publication waits for its merge.
    const waiting = await plan(workspace);
    expect(reasons(waiting)).toContain("stack_part_open");

    const registered = corrected.json.data.branchReview as Registered;
    const commits = (
      await Bun.$`git -C ${workspace.repo} rev-list --reverse ${stack.final.acceptedFirst.json.data.landing.from}..${registered.headCommit}`.quiet()
    ).stdout
      .toString()
      .trim()
      .split("\n");
    expect(commits[0]).toBe(stack.commits[0]);
    const reviewer = await startBranchReviewer(
      workspace,
      stack.producer,
      registered,
      "branch-reviewer-again",
    );
    const report = branchReport(workspace, registered.snapshotIdentity, [], {
      observedChecks: [{ name: "true", outcome: "passed" }],
    });
    const reported = await reportReview(workspace, reviewer, registered.reviewId, {
      ...report,
      published: { ...PUBLISHED_TEXT, cuts: [{ after: commits[1], ...PART_THREE }] },
    });
    expect(reported.json.reason).toBe("review_reported");
    await acceptReview(workspace, stack.producer, {
      reviewAssignmentId: registered.assignmentId,
      attemptId: reviewer.attemptId,
      revision: reviewer.revision,
    });

    // A person merges part 1, so the new publication starts on its published commit: it holds
    // only the commits above it and replaces only the recalled parts.
    await mergePart(workspace, { number: first, head: stack.commits[0] ?? "", method: "merge" });
    await publishStatus(workspace, stack.producer);
    const again = await plan(workspace);
    expect(reasons(again)).not.toContain("stack_part_open");
    expect(again.json.data.names).toEqual([
      "operator/fveracoechea-operator-15/2/1",
      "operator/fveracoechea-operator-15/2/2",
    ]);
    expect(again.json.data.closes).toEqual([second, third]);
    const text = await Bun.file(`${workspace.repo}/${again.json.data.planPath}`).text();
    expect(text).not.toContain(`/commit/${stack.commits[0]}`);
    expect(text).toContain(`/commit/${commits[1]}`);
    expect(text).toContain(`/commit/${commits[2]}`);
  });

  test("a retarget conflict waits on a person, and their settlement ends it", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const stack = await publishedStack(workspace);
    const [first = 0, second = 0] = stack.numbers;
    await mergePart(workspace, { number: first, head: stack.commits[0] ?? "", method: "merge" });
    await publishStatus(workspace, stack.producer);
    // A person closes part 2 on GitHub before the retarget reads it.
    await changePull(workspace, second, { state: "closed" });

    const stopped = await retarget(workspace, stack.producer, 2);
    expect(stopped.json.reason).toBe("publish_conflict");
    const settlement = stopped.json.blockers[0].settlement;
    expect(settlement).toMatchObject({
      action: "stack-fault",
      scope: SOURCE,
      targets: [`${REPOSITORY}#${second}`],
    });
    const waiting = await nextActions(workspace);
    expect(waiting.of("settle_publish").blocker).toBe("publish_conflict");
    expect(waiting.of("settle_publish").detail).toContain(settlement.requestRevision);

    const granted = await grant(workspace, stack.producer, settlement);
    expect(granted.json.reason).toBe("approval_granted");
    const settled = await nextActions(workspace);
    expect(
      settled.forAction("settle_publish").filter((one) => one.blocker === "publish_conflict"),
    ).toEqual([]);
    // The read records the close as GitHub shows it, and Operator writes nothing over it.
    const read = await publishStatus(workspace, stack.producer);
    expect(read.json.reason).toBe("stack_fault");
    expect(read.json.blockers[0]).toMatchObject({ number: second, fault: "closed_unmerged" });
  });
});

test("the publish skill topic says how to propose cut points with reasons", async () => {
  const topic = await Bun.file(`${import.meta.dir}/../../skills/operator/PUBLISH.md`).text();
  expect(topic).toContain("## Cut points");
  expect(topic).toContain("its report holds `published.cuts`");
  expect(topic).toContain("the `reason` for the cut");
});
