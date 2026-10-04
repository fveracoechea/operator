import { afterEach, describe, expect, test as bunTest } from "bun:test";
import { Database } from "bun:sqlite";
import {
  grantDirection,
  makeReviewWorkspace,
  startProducer,
  type Workspace,
} from "./review-cycle-fixture.ts";
import {
  acceptedOneCommit,
  apply,
  editPull,
  mergeOnGithub,
  normalized,
  plan,
  publishStatus,
  pullsOf,
  recordTracker,
  REPOSITORY,
  SOURCE,
} from "./publish-fixture.ts";
import { readFake } from "./source-fixture.ts";
import {
  githubCalls,
  herdrCalls,
  nextActions,
  requestId as request,
  runJson,
  runOperator,
  workspaces,
} from "./workspace-fixture.ts";

// Each test runs a producer, a reviewer, and gate runs through the CLI.
// Each test states its own bound, because a process-wide default would set the bound of every
// file in the bun test process (#179).
function test(name: string, run: () => Promise<void> | void, timeoutMs = 300_000) {
  bunTest(name, run, timeoutMs);
}

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

const ISSUE = "1501";
const CLOSES = `${REPOSITORY}#${ISSUE}`;
const STATUS = `operator publish status --source ${SOURCE}`;

/** The parent issue of the source, which a wayfinder source records as its map issue. */
const MAP_ISSUE = 15;

/**
 * Gives the source of the fixture a map issue, as a wayfinder source records its parent. The
 * review-cycle fixture registers a specification, which records none.
 */
function recordMapIssue(workspace: Workspace): void {
  const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`);
  try {
    sqlite
      .query(
        "update work_sources set tracker_location = json_set(tracker_location, '$.mapIssue', ?)",
      )
      .run(MAP_ISSUE);
  } finally {
    sqlite.close();
  }
}

/** One accepted code result, published as a stack of one behind the approval of its plan. */
async function publishedOneCommit(workspace: Workspace, options: { mapIssue?: boolean } = {}) {
  const accepted = await acceptedOneCommit(workspace);
  if (options.mapIssue === true) recordMapIssue(workspace);
  const planned = await plan(workspace);
  expect(planned.json.reason).toBe("publish_planned");
  const { planRevision, planPath, approval } = planned.json.data;
  const granted = await grantDirection(
    workspace,
    accepted.producer,
    { approval },
    "Publish exactly this plan.",
  );
  expect(granted.json.reason).toBe("approval_granted");
  const published = await apply(workspace, accepted.producer, planRevision);
  expect(published.json.reason).toBe("published");
  // GitHub names the head of the pull request by the commit the push carried.
  const [pull] = await pullsOf(workspace);
  await editPull(workspace, {
    head: {
      ...pull?.head,
      ref: pull?.head.ref ?? "",
      label: pull?.head.label ?? "",
      sha: accepted.commit,
    },
  });
  return {
    ...accepted,
    planPath: planPath as string,
    approval,
    approvalId: granted.json.data.approvalId as string,
    number: published.json.data.pullRequests[0].number as number,
  };
}

/** The comments the tracker holds on the ticket of the one item. */
async function ticketComments(workspace: Workspace): Promise<string[]> {
  return ((await readFake(workspace.github)).comments[ISSUE] ?? []).map((one) => one.body);
}

/** The comments the tracker holds on the map issue of the source. */
async function mapComments(workspace: Workspace): Promise<string[]> {
  return ((await readFake(workspace.github)).comments[String(MAP_ISSUE)] ?? []).map(
    (one) => one.body,
  );
}

/** The map amendment one code result states, against the baseline its map shows now (decision 18). */
async function amendmentOf(workspace: Workspace, producer: { assignmentId: string }, body: string) {
  const map = await runJson(workspace, ["tracker", "map", "--assignment", producer.assignmentId]);
  return {
    step: "map_amendment",
    decisionLink: `https://github.com/${REPOSITORY}/issues/${ISSUE}`,
    baselineIdentity: map.json.data.baselineIdentity as string,
    sections: ["Decisions so far"],
    supersedes: [],
    body,
  };
}

/** The `record_tracker` offer of the map amendment step of one assignment. */
function mapOffers(next: Awaited<ReturnType<typeof nextActions>>, assignmentId: string) {
  return next
    .forAction("record_tracker")
    .filter((one) => one.assignmentId === assignmentId && one.detail.includes("map_amendment"));
}

/** Every gate checkout the crew state records, by its path. */
function gateCheckouts(workspace: Workspace): string[] {
  const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`, {
    readonly: true,
  });
  try {
    return sqlite
      .query<{ path: string }, []>("select path from gate_checkouts")
      .all()
      .map((one) => one.path);
  } finally {
    sqlite.close();
  }
}

async function localBranches(workspace: Workspace): Promise<string> {
  return (
    await Bun.$`git -C ${workspace.repo} for-each-ref --format=${"%(refname) %(objectname)"} refs/heads`.quiet()
  ).stdout
    .toString()
    .trim();
}

describe("the tracker steps of a code result", () => {
  test("reproduction: an accepted code result cannot close its ticket before any merge", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const accepted = await acceptedOneCommit(workspace);

    // Nothing is published, so no commit of this result is on the target branch.
    const next = await nextActions(workspace);
    expect(next.forAction("record_tracker")).toEqual([]);

    const closed = await recordTracker(workspace, accepted.producer, {
      revision: accepted.revision,
      input: { step: "completion", reason: "completed" },
    });
    expect(closed.json.reason).toBe("merge_not_observed");
    expect((await readFake(workspace.github)).issues[ISSUE]?.state).toBe("open");
  });

  test("the publish approval names each tracker step after the merge, with its text rendered", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const published = await publishedOneCommit(workspace);

    expect(published.approval.targets).toEqual([
      "operator/fveracoechea-operator-15/1/1",
      "main",
      `github:${CLOSES}:resolution`,
      `github:${CLOSES}:completion`,
    ]);
    const text = await Bun.file(`${workspace.repo}/${published.planPath}`).text();
    const marker = "<!-- resolution start -->\n";
    const resolution = text.slice(
      text.indexOf(marker) + marker.length,
      text.indexOf("\n<!-- resolution end -->"),
    );
    expect(normalized(`${resolution}\n`)).toBe(
      await Bun.file(`${import.meta.dir}/publish-resolution.fixture.md`).text(),
    );
  });
});

describe("the map amendment of a code result", () => {
  test("the publish approval names it, and it writes only the exact text a second approval binds", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const published = await publishedOneCommit(workspace, { mapIssue: true });
    const { assignmentId } = published.producer;
    expect(published.approval.targets).toContain(`github:${CLOSES}:map_amendment`);
    const plan = await Bun.file(`${workspace.repo}/${published.planPath}`).text();
    expect(plan).toContain(`github:${CLOSES}:map_amendment`);

    await mergeOnGithub(workspace, { head: published.commit, method: "merge" });
    await publishStatus(workspace, published.producer);
    expect(mapOffers(await nextActions(workspace), assignmentId)).toEqual([
      expect.objectContaining({ blocker: null, command: "operator tracker record" }),
    ]);

    // The first record renders the text and writes nothing: it asks for an approval of it.
    const stated = await amendmentOf(workspace, published.producer, "- The first decision.");
    const asked = await recordTracker(workspace, published.producer, {
      revision: published.revision,
      input: stated,
    });
    expect(asked.json.reason).toBe("map_amendment_approval_required");
    const { approval, planPath } = asked.json.blockers[0];
    expect(approval).toMatchObject({
      action: "map-amendment",
      targets: [`github:${REPOSITORY}#${MAP_ISSUE}:map_amendment`],
      scope: assignmentId,
    });
    const rendered = await Bun.file(`${workspace.repo}/${planPath}`).text();
    expect(rendered).toContain("- The first decision.");
    expect(await mapComments(workspace)).toEqual([]);

    // crew next renders the same text, and the step waits for its approval.
    const [waiting] = mapOffers(await nextActions(workspace), assignmentId);
    expect(waiting?.blocker).toBe("approval_required");
    expect(waiting?.detail).toContain(approval.requestRevision);
    expect(waiting?.detail).toContain(planPath);

    // An approval of other text covers nothing.
    const other = await grantDirection(
      workspace,
      published.producer,
      { approval: { ...approval, requestRevision: "0".repeat(64) } },
      "Amend the map with other text.",
    );
    expect(other.json.reason).toBe("approval_granted");
    const refused = await recordTracker(workspace, published.producer, {
      revision: published.revision,
      input: stated,
    });
    expect(refused.json.reason).toBe("map_amendment_approval_required");
    expect(await mapComments(workspace)).toEqual([]);

    // The person rejects the text, so the Operator states another before any write.
    const restated = await amendmentOf(workspace, published.producer, "- The second decision.");
    const askedAgain = await recordTracker(workspace, published.producer, {
      revision: published.revision,
      input: restated,
    });
    expect(askedAgain.json.reason).toBe("map_amendment_approval_required");
    expect(askedAgain.json.blockers[0].approval.requestRevision).not.toBe(approval.requestRevision);

    const granted = await grantDirection(
      workspace,
      published.producer,
      { approval: askedAgain.json.blockers[0].approval },
      "Amend the map with exactly this text.",
    );
    expect(granted.json.reason).toBe("approval_granted");
    expect(mapOffers(await nextActions(workspace), assignmentId)).toEqual([
      expect.objectContaining({ blocker: null }),
    ]);
    const written = await recordTracker(workspace, published.producer, {
      revision: published.revision,
      input: restated,
    });
    expect(written.json.reason).toBe("tracker.completed");
    const comments = await mapComments(workspace);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("- The second decision.");
    expect(comments[0]).not.toContain("- The first decision.");
  });

  test("it refuses with no write when the publish approval no longer names it", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const published = await publishedOneCommit(workspace, { mapIssue: true });
    await mergeOnGithub(workspace, { head: published.commit, method: "merge" });
    await publishStatus(workspace, published.producer);
    const revoked = await runJson(workspace, [
      "approval",
      "revoke",
      "--request",
      request(),
      "--owner-token",
      published.producer.ownerToken,
      "--approval",
      published.approvalId,
      "--revision",
      "1",
    ]);
    expect(revoked.json.reason).toBe("approval_revoked");

    expect(mapOffers(await nextActions(workspace), published.producer.assignmentId)).toEqual([
      expect.objectContaining({ blocker: "approval_required" }),
    ]);
    const refused = await recordTracker(workspace, published.producer, {
      revision: published.revision,
      input: await amendmentOf(workspace, published.producer, "- The decision."),
    });
    expect(refused.json.reason).toBe("publish_approval_missing");
    expect(await mapComments(workspace)).toEqual([]);
  });
});

describe("the merge observation", () => {
  test("crew next waits on stack_open with the read, and never calls GitHub", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const published = await publishedOneCommit(workspace);

    const before = (await githubCalls(workspace)).length;
    const next = await nextActions(workspace);
    expect(next.waits).toContainEqual(
      expect.objectContaining({ wait: "stack_open", sourceId: SOURCE, command: STATUS }),
    );
    expect(next.forAction("record_tracker")).toEqual([]);
    expect((await githubCalls(workspace)).length).toBe(before);

    // The read of an open pull request records it open, and the wait stays.
    const read = await publishStatus(workspace, published.producer);
    expect(read.json.reason).toBe("publish_observed");
    expect(read.json.data.seen).toEqual([
      expect.objectContaining({ part: 1, number: published.number, state: "open", fault: null }),
    ]);
    expect((await nextActions(workspace)).waiting).toContain("stack_open");
  });

  test("a merge commit offers the tracker steps, renders the resolution, and finishes the source", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const published = await publishedOneCommit(workspace);
    const branchesBefore = await localBranches(workspace);
    const [checkout] = gateCheckouts(workspace);
    expect(checkout).toBeDefined();

    const mergeCommit = await mergeOnGithub(workspace, {
      head: published.commit,
      method: "merge",
    });
    const callsBefore = (await githubCalls(workspace)).length;
    const read = await runOperator(workspace, [
      "publish",
      "status",
      "--request",
      request(),
      "--owner-token",
      published.producer.ownerToken,
      "--source",
      SOURCE,
    ]);
    expect(read.exitCode).toBe(0);
    // The report is a summary of one line for each pull request (R5).
    expect(read.stdout).toContain(`part 1: #${published.number} is merged by a merge commit`);
    expect(read.stdout.split("\n").length).toBeLessThan(8);
    // The read only reads: it never merges, and never turns on auto-merge (R2, D6).
    for (const call of (await githubCalls(workspace)).slice(callsBefore)) {
      expect(call).toMatch(
        /^GET repos\/fveracoechea\/operator\/(pulls\/\d+|commits\/[0-9a-f]{40})$/,
      );
    }

    const next = await nextActions(workspace);
    expect(next.waiting).not.toContain("stack_open");
    expect(
      next
        .forAction("record_tracker")
        .filter((one) => one.assignmentId === published.producer.assignmentId),
    ).toEqual([
      expect.objectContaining({ blocker: null, detail: "The resolution step is unrecorded." }),
      expect.objectContaining({ blocker: null, detail: "The completion step is unrecorded." }),
    ]);

    // A code resolution has no free body.
    const free = await recordTracker(workspace, published.producer, {
      revision: published.revision,
      input: { step: "resolution", body: "## Resolution\n\nDone." },
    });
    expect(free.json.reason).toBe("code_resolution_body_not_allowed");
    expect(await ticketComments(workspace)).toEqual([]);

    const resolved = await recordTracker(workspace, published.producer, {
      revision: published.revision,
      input: { step: "resolution" },
    });
    expect(resolved.json.reason).toBe("tracker.completed");
    const [comment] = await ticketComments(workspace);
    expect(comment).toContain(
      `Done in [\`${published.commit.slice(0, 12)}\`](https://github.com/${REPOSITORY}/commit/${published.commit}) in ${REPOSITORY}#${published.number}, merged into \`main\` by a merge commit.`,
    );
    expect(comment).not.toContain(mergeCommit);

    const notPlanned = await recordTracker(workspace, published.producer, {
      revision: published.revision,
      input: { step: "completion", reason: "not_planned" },
    });
    expect(notPlanned.json.reason).toBe("completion_reason_not_approved");

    // Herdr refuses to remove a gate checkout that holds a change, so it stays (R3).
    await Bun.write(`${checkout}/left-behind.txt`, "unlanded\n");
    const completed = await recordTracker(workspace, published.producer, {
      revision: published.revision,
      input: { step: "completion", reason: "completed" },
    });
    expect(completed.json.reason).toBe("tracker.completed");
    expect((await readFake(workspace.github)).issues[ISSUE]?.state).toBe("closed");
    expect(completed.json.data.finish).toMatchObject({ status: "finished", gateCheckout: "kept" });
    expect(gateCheckouts(workspace)).toEqual([checkout ?? ""]);
    expect(await Bun.file(`${checkout}/left-behind.txt`).exists()).toBe(true);

    // The source is finished, so a read removes the clean gate checkout and keeps every branch.
    await Bun.$`rm ${checkout}/left-behind.txt`.quiet();
    const finished = await publishStatus(workspace, published.producer);
    expect(finished.json.data.finish).toEqual({
      status: "finished",
      gateCheckout: "removed",
      detail: null,
    });
    expect(gateCheckouts(workspace)).toEqual([]);
    expect(await Bun.file(checkout ?? "").exists()).toBe(false);
    expect(await localBranches(workspace)).toBe(branchesBefore);
    const removals = (await herdrCalls(workspace)).filter((one) => one.includes("worktree remove"));
    expect(removals.length).toBeGreaterThan(0);
    for (const one of removals) {
      expect(one).not.toContain("--force");
    }
  });

  test("a squash merge is a stack fault, and the tracker steps of its item still run", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const published = await publishedOneCommit(workspace);
    const landed = await mergeOnGithub(workspace, { head: published.commit, method: "squash" });

    const read = await publishStatus(workspace, published.producer);
    expect(read.json.reason).toBe("stack_fault");
    expect(read.json.blockers).toEqual([
      expect.objectContaining({ reason: "stack_fault", fault: "not_merge_commit" }),
    ]);

    const next = await nextActions(workspace);
    expect(next.of("settle_publish")).toMatchObject({
      sourceId: SOURCE,
      blocker: "stack_fault",
      command: STATUS,
    });
    expect(
      next
        .forAction("record_tracker")
        .filter((one) => one.assignmentId === published.producer.assignmentId),
    ).toHaveLength(2);

    const resolved = await recordTracker(workspace, published.producer, {
      revision: published.revision,
      input: { step: "resolution" },
    });
    expect(resolved.json.reason).toBe("tracker.completed");
    const [comment] = await ticketComments(workspace);
    expect(comment).toContain(
      `Done in [\`${landed.slice(0, 12)}\`](https://github.com/${REPOSITORY}/commit/${landed}) in ${REPOSITORY}#${published.number}, merged into \`main\` by a squash or rebase merge, not a merge commit.`,
    );

    // A stack fault keeps the source open, so its gate checkout stays.
    const completed = await recordTracker(workspace, published.producer, {
      revision: published.revision,
      input: { step: "completion", reason: "completed" },
    });
    expect(completed.json.reason).toBe("tracker.completed");
    expect(completed.json.data.finish.status).toBe("not-finished");
    expect(gateCheckouts(workspace)).toHaveLength(1);

    // Only the person settles a fault: the read names the approval, and nothing else does.
    const settlement = read.json.blockers[0].settlement;
    expect(settlement).toMatchObject({
      action: "stack-fault",
      targets: [`${REPOSITORY}#${published.number}`],
      scope: SOURCE,
    });
    expect((await nextActions(workspace)).of("settle_publish").blocker).toBe("stack_fault");
    const granted = await grantDirection(
      workspace,
      published.producer,
      { approval: settlement },
      "The squash merge stands.",
    );
    expect(granted.json.reason).toBe("approval_granted");
    expect((await nextActions(workspace)).forAction("settle_publish")).toEqual([]);

    // The settlement binds the reading that recorded the fault, so another merge is a new fault.
    await mergeOnGithub(workspace, { head: published.commit, method: "squash" });
    const other = await publishStatus(workspace, published.producer);
    expect(other.json.reason).toBe("stack_fault");
    expect(other.json.blockers[0].settlement.requestRevision).not.toBe(settlement.requestRevision);
    expect((await nextActions(workspace)).of("settle_publish").blocker).toBe("stack_fault");
    await editPull(workspace, { merge_commit_sha: landed });

    // The settled squash landed every commit of the source, so the next read finishes it.
    const settled = await publishStatus(workspace, published.producer);
    expect(settled.json.reason).toBe("publish_observed");
    expect(settled.json.data.finish).toMatchObject({ status: "finished", gateCheckout: "removed" });
    expect(gateCheckouts(workspace)).toEqual([]);
  });

  test("a settled close with no merge ends its part, and a new stack publication carries its commits", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const published = await publishedOneCommit(workspace);
    await editPull(workspace, { state: "closed" });
    const read = await publishStatus(workspace, published.producer);
    const unsettled = await nextActions(workspace);
    expect(unsettled.of("settle_publish").blocker).toBe("stack_fault");
    expect(unsettled.forAction("publish_stack")).toEqual([]);
    const granted = await grantDirection(
      workspace,
      published.producer,
      { approval: read.json.blockers[0].settlement },
      "The close stands.",
    );
    expect(granted.json.reason).toBe("approval_granted");

    // The person settled the fault, so the path is a new stack publication behind its approval.
    const next = await nextActions(workspace);
    expect(next.forAction("settle_publish")).toEqual([]);
    expect(next.of("publish_stack").blocker).toBe("approval_required");
    expect(next.waiting).not.toContain("stack_open");
    expect((await publishStatus(workspace, published.producer)).json.data.finish.status).toBe(
      "not-finished",
    );
    expect(gateCheckouts(workspace)).toHaveLength(1);
    const again = await plan(workspace);
    expect(again.json.reason).toBe("publish_planned");
    expect(again.json.data.publication).toBe(2);
    // The closed pull request is not closed again, so the approval names no close.
    expect(again.json.data.approval.targets).not.toContain(`${REPOSITORY}#${published.number}`);
  });

  test("a close with no merge, a moved head, and a merge into another base complete nothing", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const published = await publishedOneCommit(workspace);
    const [pull] = await pullsOf(workspace);
    const head = { ref: pull?.head.ref ?? "", label: pull?.head.label ?? "" };
    const faults = [
      { change: { state: "closed" }, fault: "closed_unmerged" },
      { change: { state: "open", head: { ...head, sha: "2".repeat(40) } }, fault: "head_moved" },
    ];
    for (const one of faults) {
      await editPull(workspace, one.change);
      const read = await publishStatus(workspace, published.producer);
      expect(read.json.reason).toBe("stack_fault");
      expect(read.json.blockers[0]).toMatchObject({ fault: one.fault });
      const next = await nextActions(workspace);
      expect(next.of("settle_publish").blocker).toBe("stack_fault");
      expect(next.forAction("record_tracker")).toEqual([]);
    }

    await mergeOnGithub(workspace, { head: published.commit, method: "merge", base: "release" });
    const read = await publishStatus(workspace, published.producer);
    expect(read.json.blockers[0]).toMatchObject({ fault: "base_not_target" });
    expect((await nextActions(workspace)).forAction("record_tracker")).toEqual([]);
    const closed = await recordTracker(workspace, published.producer, {
      revision: published.revision,
      input: { step: "completion", reason: "completed" },
    });
    expect(closed.json.reason).toBe("merge_not_observed");
    expect((await readFake(workspace.github)).issues[ISSUE]?.state).toBe("open");
  });

  test("no tracker write after the merge happens without the publish approval", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const published = await publishedOneCommit(workspace);
    await mergeOnGithub(workspace, { head: published.commit, method: "merge" });
    await publishStatus(workspace, published.producer);
    const revoked = await runJson(workspace, [
      "approval",
      "revoke",
      "--request",
      request(),
      "--owner-token",
      published.producer.ownerToken,
      "--approval",
      published.approvalId,
      "--revision",
      "1",
    ]);
    expect(revoked.json.reason).toBe("approval_revoked");

    const next = await nextActions(workspace);
    expect(
      next
        .forAction("record_tracker")
        .filter((one) => one.assignmentId === published.producer.assignmentId),
    ).toEqual([
      expect.objectContaining({ blocker: "approval_required" }),
      expect.objectContaining({ blocker: "approval_required" }),
    ]);
    const refused = await recordTracker(workspace, published.producer, {
      revision: published.revision,
      input: { step: "resolution" },
    });
    expect(refused.json.reason).toBe("publish_approval_missing");
    expect(await ticketComments(workspace)).toEqual([]);
  });
});

test("the publish skill topic states the one prose trigger of the merge read", async () => {
  const topic = await Bun.file(`${import.meta.dir}/../../skills/operator/PUBLISH.md`).text();
  expect(topic).toContain(
    "Run `bun run operator publish status` when the user reports a merge or a close",
  );
});

// A named departure of #138: before, the read refused `nothing_published` before it parsed the
// tracker location. Now it parses the location first, so a damaged one fails loudly. Only a
// damaged state file gets here.
test("a tracker location that this release cannot read stops the merge read loudly", async () => {
  const workspace = await makeReviewWorkspace(fixtures);
  const producer = await startProducer(workspace);
  expect((await publishStatus(workspace, producer)).json.reason).toBe("nothing_published");
  const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`);
  sqlite.run("update work_sources set tracker_location = '{\"damaged\":true}'");
  sqlite.close();

  const read = await runOperator(workspace, [
    "publish",
    "status",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--source",
    SOURCE,
    "--json",
  ]);
  expect(read.exitCode).not.toBe(0);
  expect(read.stdout + read.stderr).toContain(
    "the crew state holds a tracker location this release cannot read",
  );
});
