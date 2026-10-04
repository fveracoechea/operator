import { afterAll, describe, expect, test as bunTest } from "bun:test";
import { Database } from "bun:sqlite";
import {
  type FixtureSource,
  type FixtureTarget,
  fakeIssue,
  issueKey,
  planSource,
  readFake,
  registerSource,
  withdrawIssues,
  workspaceTarget,
  writeFake,
  writeInput,
} from "./source-fixture.ts";
import {
  acceptProduction,
  acceptReview,
  commitArtifact,
  invalidateResult,
  makeReviewWorkspace,
  type Producer,
  reportBody,
  reportReview,
  startProducer,
  startReviewer,
  submissionBody,
  submit,
  type Workspace as ReviewWorkspace,
} from "./review-cycle-fixture.ts";
import {
  MAP_ISSUE,
  makeTrackerWorkspace,
  recordStep,
  resolutionBody,
  setFault,
  TICKET,
} from "./tracker-fixture.ts";
import {
  nextActions,
  ownCrew,
  requestId,
  runJson,
  type Workspace,
  workspaces,
} from "./workspace-fixture.ts";

// Each test runs several CLI processes against one fixture repository and the GitHub fake.
// Each test states its own bound, because a process-wide default would set the bound of every
// file in the bun test process (#179).
function test(name: string, run: () => Promise<void> | void, timeoutMs = 60_000) {
  bunTest(name, run, timeoutMs);
}

const fixtures = workspaces();

afterAll(async () => {
  await fixtures.removeAll();
});

const key = (number: number) => issueKey(number);
const MAP = 90;

type Refusal = { reason: string; key: string; [field: string]: unknown };

async function owned(): Promise<{ workspace: Workspace; token: string; target: FixtureTarget }> {
  const workspace = await fixtures.make();
  const token = await ownCrew(workspace);
  return {
    workspace,
    token,
    target: {
      root: workspace.root,
      github: workspace.github,
      run: (args) => runJson(workspace, args),
    },
  };
}

/** A map with two tasks, where the second waits on the first. */
const TASKS: FixtureSource = {
  sourceKind: "wayfinder",
  parent: MAP,
  items: [
    { key: "a", issue: 91, wayfinderType: "task" },
    { key: "b", issue: 92, wayfinderType: "task", dependsOn: [{ key: "a" }] },
    { key: "c", issue: 93, wayfinderType: "task" },
  ],
};

/** Removes one sub-issue from its parent, as a person does on GitHub. */
async function removeSubIssue(github: string, parent: number, number: number) {
  const state = await readFake(github);
  state.subIssues = {
    ...state.subIssues,
    [String(parent)]: (state.subIssues?.[String(parent)] ?? []).filter(
      (one) => one.number !== number,
    ),
  };
  await writeFake(github, state);
}

/** Adds one issue the fake already holds to the end of its parent again. */
async function addSubIssue(github: string, parent: number, number: number) {
  const state = await readFake(github);
  const issue = state.issues[String(number)];
  if (issue === undefined) {
    throw new Error(`the fake holds no issue ${number}`);
  }
  state.subIssues = {
    ...state.subIssues,
    [String(parent)]: [...(state.subIssues?.[String(parent)] ?? []), issue],
  };
  await writeFake(github, state);
}

/** Adds one new open task under the map, keeping the blocking links the fake already holds. */
async function registerLater(github: string, number: number) {
  const state = await readFake(github);
  const issue = fakeIssue({
    number,
    title: `Item ${number}`,
    body: `Scope ${number}.`,
    labels: ["wayfinder:task"],
  });
  state.issues[String(number)] = issue;
  state.subIssues = {
    ...state.subIssues,
    [String(MAP)]: [...(state.subIssues?.[String(MAP)] ?? []), issue],
  };
  await writeFake(github, state);
}

async function claim(workspace: Workspace, token: string, assignmentId: string) {
  return runJson(workspace, [
    "work",
    "claim",
    "--request",
    requestId(),
    "--owner-token",
    token,
    "--assignment",
    assignmentId,
    "--revision",
    "1",
  ]);
}

/** Drops every blocking link of one issue, as a person does on GitHub. */
async function dropBlockers(github: string, number: number) {
  const state = await readFake(github);
  state.blockedBy = { ...state.blockedBy, [String(number)]: [] };
  await writeFake(github, state);
}

/** Previews a new read whose input names the given issues, with the default execution fields. */
async function preview(target: FixtureTarget, parent: number, named: string[] = []) {
  const inputPath = await writeInput(target.root, {
    sourceKind: "wayfinder",
    source: key(parent),
    items: named.map((issue) => ({
      issue,
      acceptanceRequirements: ["The quality gate passes."],
      permissions: {
        writePaths: [`modules/${issue.split("#")[1]}/`],
        allowedCommands: [],
        network: false,
      },
      fixedInputs: [],
    })),
  });
  return { plan: await planSource(target, inputPath), inputPath };
}

async function register(workspace: Workspace, token: string, inputPath: string, revision: string) {
  return runJson(workspace, [
    "work",
    "register",
    "--request",
    requestId(),
    "--owner-token",
    token,
    "--input",
    inputPath,
    "--plan-revision",
    revision,
  ]);
}

async function grant(workspace: Workspace, token: string, approval: unknown) {
  const inputPath = await writeInput(workspace.root, {
    ...(approval as object),
    exactText: "Yes, record that plan.",
    grantedBy: "human",
  });
  return runJson(workspace, [
    "approval",
    "grant",
    "--request",
    requestId(),
    "--owner-token",
    token,
    "--input",
    inputPath,
  ]);
}

async function planFile(workspace: Workspace, plan: { json: { data: { planPath: string } } }) {
  return Bun.file(`${workspace.repo}/${plan.json.data.planPath}`).json();
}

async function refusalsOf(workspace: Workspace, plan: { json: { data: { planPath: string } } }) {
  const held: { refusals: Refusal[] } = await planFile(workspace, plan);
  return held.refusals;
}

/** Reads recorded rows directly, because no command reports every state of every row. */
function recorded(workspace: Workspace) {
  const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`, {
    readonly: true,
  });
  try {
    return {
      assignments: sqlite
        .query(
          "select id, source_key, state, withdrawn_under from assignments order by order_index",
        )
        .all() as Array<{
        id: string;
        source_key: string;
        state: string;
        withdrawn_under: string | null;
      }>,
      dependencies: sqlite
        .query("select assignment_id, depends_on_id from assignment_dependencies")
        .all() as Array<{ assignment_id: string; depends_on_id: string }>,
    };
  } finally {
    sqlite.close();
  }
}

describe("withdrawal by removing an issue from its parent", () => {
  test("records a removed sub-issue of a map as withdrawn behind the plan approval", async () => {
    const { workspace, token, target } = await owned();
    const first = await registerSource(target, token, TASKS);
    expect(first.exitCode).toBe(0);
    const c = first.keys.get("c") ?? "";

    await removeSubIssue(workspace.github, MAP, 93);
    const { plan, inputPath } = await preview(target, MAP);

    expect(plan.json.reason).toBe("registration_planned");
    expect(plan.json.data.counts).toMatchObject({ withdrawn: 1, refusals: 0 });
    const approval = {
      action: "registration-change",
      targets: [key(MAP)],
      scope: key(MAP),
      requestRevision: plan.json.data.planRevision,
    };
    expect(plan.json.data.approval).toEqual(approval);
    const held = await planFile(workspace, plan);
    expect(held.withdrawals).toEqual([
      { key: key(93), assignmentId: c, state: "registered", landing: null, rebuilds: [] },
    ]);

    // Only the approval of the person records the withdrawal.
    const refused = await register(workspace, token, inputPath, plan.json.data.planRevision);
    expect(refused.json.reason).toBe("approval_required");
    expect(recorded(workspace).assignments.find((one) => one.id === c)?.state).toBe("registered");

    await grant(workspace, token, approval);
    const registered = await register(workspace, token, inputPath, plan.json.data.planRevision);
    expect(registered.exitCode).toBe(0);
    expect(registered.json.data.counts).toEqual({ registered: 0, updated: 0, withdrawn: 1 });
    const row = recorded(workspace).assignments.find((one) => one.id === c);
    expect(row).toMatchObject({ state: "withdrawn", withdrawn_under: plan.json.data.planRevision });

    // A withdrawn item is terminal and is never offered.
    const frontier = await runJson(workspace, ["work", "frontier", "--json"]);
    expect(
      frontier.json.data.withdrawn.map((one: { assignmentId: string }) => one.assignmentId),
    ).toEqual([c]);
    expect(
      frontier.json.data.dispatchable.map((one: { assignmentId: string }) => one.assignmentId),
    ).not.toContain(c);

    // A withdrawal is recorded once, so the next read has nothing to approve.
    const again = await preview(target, MAP);
    expect(again.plan.json.data.counts).toMatchObject({ withdrawn: 0, refusals: 0 });
    expect(again.plan.json.data.approval).toBeNull();

    // A withdrawn issue that a person adds to its parent again is refused and named.
    await addSubIssue(workspace.github, MAP, 93);
    const readded = await preview(target, MAP);
    expect(readded.plan.json.reason).toBe("registration_refused");
    expect(await refusalsOf(workspace, readded.plan)).toEqual([
      { reason: "withdrawn_item_readded", key: key(93), assignmentId: c },
    ]);

    // A withdrawn item never starts again.
    const claimed = await claim(workspace, token, c);
    expect(claimed.json.reason).toBe("assignment_withdrawn");
  });

  test("refuses and names an active attempt of the item", async () => {
    const { workspace, token, target } = await owned();
    const first = await registerSource(target, token, TASKS);
    const c = first.keys.get("c") ?? "";
    const claimed = await claim(workspace, token, c);
    expect(claimed.json.reason).toBe("assignment_claimed");

    await removeSubIssue(workspace.github, MAP, 93);
    const { plan } = await preview(target, MAP);

    expect(plan.json.reason).toBe("registration_refused");
    expect(await refusalsOf(workspace, plan)).toEqual([
      {
        reason: "withdrawal_attempt_active",
        key: key(93),
        assignmentId: c,
        attemptId: claimed.json.data.attemptId,
        holder: c,
      },
    ]);
  });

  test("closes the open direction request of the item", async () => {
    const { workspace, token, target } = await owned();
    const first = await registerSource(target, token, TASKS);
    const c = first.keys.get("c") ?? "";
    // A limit that only the person directs. The fixture writes the row that the limit raises.
    const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`);
    try {
      const now = new Date().toISOString();
      sqlite
        .query(
          "insert into direction_requests (id, assignment_id, limit_kind, limit_value, evidence, state, approval_id, revision, raised_at, updated_at) values (?, ?, 'rework_cycles', 3, ?, 'open', null, 1, ?, ?)",
        )
        .run(
          "direction-1",
          c,
          JSON.stringify({ used: 3, detail: "Three cycles reported.", attempted: [] }),
          now,
          now,
        );
    } finally {
      sqlite.close();
    }
    expect((await nextActions(workspace)).forAction("direct_limit")).toHaveLength(1);

    await removeSubIssue(workspace.github, MAP, 93);
    const { plan, inputPath } = await preview(target, MAP);
    await grant(workspace, token, plan.json.data.approval);
    const registered = await register(workspace, token, inputPath, plan.json.data.planRevision);
    expect(registered.exitCode).toBe(0);

    const read = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`, {
      readonly: true,
    });
    try {
      expect(read.query("select state from direction_requests").all()).toEqual([
        { state: "withdrawn" },
      ]);
    } finally {
      read.close();
    }
    expect((await nextActions(workspace)).forAction("direct_limit")).toEqual([]);
  });

  test("refuses while a dependent still names the item, and records a dropped link behind the approval", async () => {
    const { workspace, token, target } = await owned();
    const first = await registerSource(target, token, TASKS);
    const a = first.keys.get("a") ?? "";
    const b = first.keys.get("b") ?? "";

    await removeSubIssue(workspace.github, MAP, 91);
    const waiting = await preview(target, MAP);
    expect(await refusalsOf(workspace, waiting.plan)).toEqual([
      {
        reason: "withdrawal_dependent_pending",
        key: key(91),
        assignmentId: a,
        dependent: b,
        dependentKey: key(92),
      },
    ]);

    // The person drops the blocking link. The dependent has no attempt, so it takes the change.
    await dropBlockers(workspace.github, 92);
    const { plan, inputPath } = await preview(target, MAP, [key(92)]);
    expect(plan.json.data.counts).toMatchObject({ updated: 1, withdrawn: 1, refusals: 0 });
    await grant(workspace, token, plan.json.data.approval);
    const registered = await register(workspace, token, inputPath, plan.json.data.planRevision);
    expect(registered.exitCode).toBe(0);

    const after = recorded(workspace);
    expect(after.assignments.find((one) => one.id === a)?.state).toBe("withdrawn");
    expect(after.dependencies).toEqual([]);
    // The withdrawn item stays as history, and the work that no longer waits on it moves.
    const frontier = await runJson(workspace, ["work", "frontier", "--json"]);
    expect(
      frontier.json.data.dispatchable.map((one: { assignmentId: string }) => one.assignmentId),
    ).toContain(b);
  });

  test("never satisfies a dependency with withdrawn work", async () => {
    const { workspace, token, target } = await owned();
    const first = await registerSource(target, token, TASKS);
    const a = first.keys.get("a") ?? "";
    const b = first.keys.get("b") ?? "";
    const c = first.keys.get("c") ?? "";

    // No supported command leaves a live dependent on withdrawn work, so the row is set here.
    const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`);
    try {
      sqlite.query("update assignments set state = 'withdrawn' where id = ?").run(a);
    } finally {
      sqlite.close();
    }
    const frontier = await runJson(workspace, ["work", "frontier", "--json"]);
    expect(
      frontier.json.data.blocked.find((one: { assignmentId: string }) => one.assignmentId === b),
    ).toMatchObject({
      blockers: [
        { reason: "dependency_pending", dependencies: [{ assignmentId: a, state: "withdrawn" }] },
      ],
    });

    // A new link to withdrawn work would wait for ever, so the plan refuses it.
    await removeSubIssue(workspace.github, MAP, 91);
    await removeSubIssue(workspace.github, MAP, 93);
    const withdrawn = await preview(target, MAP);
    await grant(workspace, token, withdrawn.plan.json.data.approval);
    await register(workspace, token, withdrawn.inputPath, withdrawn.plan.json.data.planRevision);
    expect(recorded(workspace).assignments.find((one) => one.id === c)?.state).toBe("withdrawn");

    const state = await readFake(workspace.github);
    const blocker = state.issues["93"];
    state.blockedBy = { ...state.blockedBy, "94": blocker === undefined ? [] : [blocker] };
    await writeFake(workspace.github, state);
    await registerLater(workspace.github, 94);
    const linked = await preview(target, MAP, [key(94)]);
    expect(await refusalsOf(workspace, linked.plan)).toEqual([
      { reason: "blocker_withdrawn", key: key(94), blocker: key(93), assignmentId: c },
    ]);
  });
});

/** The issue of the producer item of the review fixture, the first sub-issue of parent 15. */
const PRODUCER_ISSUE = 1501;

/** One more item of the producer source, so its parent keeps a sub-issue after a withdrawal. */
const OTHER = {
  key: "22.2",
  kind: "production" as const,
  title: "Other work",
  dependsOn: [],
  writePaths: ["src/"],
};

/** Produces, reviews, and accepts one result, so a dependent can start after it. */
async function acceptedResult(workspace: ReviewWorkspace, producer: Producer) {
  const artifact = await commitArtifact(workspace, producer, "# Result\n");
  const submitted = await submit(workspace, producer, submissionBody(producer, artifact));
  const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
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
  const accepted = await acceptProduction(workspace, producer, {
    submissionId: submitted.json.data.submissionId,
    revision: submitted.json.data.revision,
  });
  expect(accepted.json.reason).toBe("assignment_accepted");
  return { artifact, accepted };
}

/** Reads one column set of every row of one table, because no command reports them all. */
function rows(workspace: ReviewWorkspace, sql: string): Array<Record<string, unknown>> {
  const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`, {
    readonly: true,
  });
  try {
    return sqlite.query(sql).all() as Array<Record<string, unknown>>;
  } finally {
    sqlite.close();
  }
}

describe("withdrawal of work that started", () => {
  test("refuses while a dependent that has an attempt names it, and names its landing", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace, undefined, {
      dependents: [
        { key: "22.2", kind: "production", title: "Use the result", writePaths: ["src/"] },
      ],
    });
    const dependent = producer.dependents.get("22.2") ?? "";
    const { artifact } = await acceptedResult(workspace, producer);
    const claimed = await runJson(workspace, [
      "work",
      "claim",
      "--request",
      requestId(),
      "--owner-token",
      producer.ownerToken,
      "--assignment",
      dependent,
      "--revision",
      "1",
    ]);
    expect(claimed.json.reason).toBe("assignment_claimed");

    // The person removes the producer and drops the link, but the dependent already read it.
    const state = await readFake(workspace.github);
    state.blockedBy = { ...state.blockedBy, "1502": [] };
    await writeFake(workspace.github, state);
    const { plan } = await withdrawIssues(workspaceTarget(workspace), producer.ownerToken, {
      sourceKind: "specification",
      parent: 15,
      numbers: [PRODUCER_ISSUE],
    });

    expect(plan.json.reason).toBe("registration_refused");
    const held = await Bun.file(`${workspace.repo}/${plan.json.data.planPath}`).json();
    expect(held.withdrawals).toEqual([
      {
        key: issueKey(PRODUCER_ISSUE),
        assignmentId: producer.assignmentId,
        state: "accepted",
        landing: artifact.commit,
        rebuilds: [],
      },
    ]);
    expect(held.refusals).toEqual([
      {
        reason: "recorded_item_changed",
        key: issueKey(1502),
        assignmentId: dependent,
        state: "claimed",
      },
      {
        reason: "withdrawal_dependent_pending",
        key: issueKey(PRODUCER_ISSUE),
        assignmentId: producer.assignmentId,
        dependent,
        dependentKey: issueKey(1502),
      },
    ]);
  });

  test("refuses while a tracker step of the item has no recorded outcome", async () => {
    const workspace = await makeTrackerWorkspace(fixtures);
    await setFault(workspace, "createComment", "lost");
    const recordedStep = await recordStep(workspace, { input: resolutionBody() });
    expect(recordedStep.exitCode).toBe(5);

    const { plan } = await withdrawIssues(workspaceTarget(workspace), workspace.ownerToken, {
      sourceKind: "wayfinder",
      parent: MAP_ISSUE,
      numbers: [TICKET],
    });

    const held = await Bun.file(`${workspace.repo}/${plan.json.data.planPath}`).json();
    expect(held.refusals).toContainEqual({
      reason: "withdrawal_effect_unsettled",
      key: issueKey(TICKET),
      assignmentId: workspace.assignmentId,
      effect: "tracker_step",
      step: "resolution",
      state: "uncertain",
    });
  });

  test("refuses while a review of its result runs", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace, undefined, { dependents: [OTHER] });
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact));
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    const { plan } = await withdrawIssues(workspaceTarget(workspace), producer.ownerToken, {
      sourceKind: "specification",
      parent: 15,
      numbers: [PRODUCER_ISSUE],
    });

    const held = await Bun.file(`${workspace.repo}/${plan.json.data.planPath}`).json();
    expect(held.refusals).toEqual([
      {
        reason: "withdrawal_attempt_active",
        key: issueKey(PRODUCER_ISSUE),
        assignmentId: producer.assignmentId,
        attemptId: reviewer.attemptId,
        holder: submitted.json.data.reviewAssignmentId,
      },
    ]);
  });

  test("closes the review that no attempt holds, keeps the history, and ends the hold", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace, undefined, {
      dependents: [{ key: "22.2", kind: "production", title: "Same paths", dependsOn: [] }],
    });
    const other = producer.dependents.get("22.2") ?? "";
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact));
    const reviewAssignment = submitted.json.data.reviewAssignmentId;

    // The submitted result holds its write paths, so the other item waits.
    const before = await runJson(workspace, ["work", "frontier", "--json"]);
    expect(
      before.json.data.blocked.find((one: { assignmentId: string }) => one.assignmentId === other)
        ?.blockers[0].reason,
    ).toBe("write_paths_overlap");

    const { registered } = await withdrawIssues(workspaceTarget(workspace), producer.ownerToken, {
      sourceKind: "specification",
      parent: 15,
      numbers: [PRODUCER_ISSUE],
    });
    expect(registered.exitCode).toBe(0);

    const states = new Map(
      rows(workspace, "select id, state from assignments").map((one) => [one.id, one.state]),
    );
    expect(states.get(producer.assignmentId)).toBe("withdrawn");
    expect(states.get(reviewAssignment)).toBe("withdrawn");
    expect(rows(workspace, "select id, state from reviews")).toEqual([
      { id: submitted.json.data.reviewId, state: "withdrawn" },
    ]);
    expect(rows(workspace, "select id, state from submissions")).toEqual([
      { id: submitted.json.data.submissionId, state: "awaiting-review" },
    ]);

    // The withdrawn result has no commit on the branch, so its paths are free again.
    const after = await runJson(workspace, ["work", "frontier", "--json"]);
    expect(
      after.json.data.dispatchable.map((one: { assignmentId: string }) => one.assignmentId),
    ).toEqual([other]);
    // Operator writes nothing to the tracker for a withdrawal.
    expect((await Bun.file(`${workspace.github}/calls.log`).text()).split("\n")).not.toContainEqual(
      expect.stringMatching(/^(POST|PATCH|DELETE)/),
    );
  });

  test("closes the open invalidation and its cycle", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace, undefined, { dependents: [OTHER] });
    const { accepted } = await acceptedResult(workspace, producer);
    const invalidated = await invalidateResult(workspace, producer, {
      assignmentId: producer.assignmentId,
      revision: accepted.json.data.revision,
      defect: { summary: "It drops a record.", evidence: "The rerun.", foundBy: "a reviewer" },
    });
    expect(invalidated.json.reason).toBe("result_invalidated");

    const { registered } = await withdrawIssues(workspaceTarget(workspace), producer.ownerToken, {
      sourceKind: "specification",
      parent: 15,
      numbers: [PRODUCER_ISSUE],
    });
    expect(registered.exitCode).toBe(0);

    expect(rows(workspace, "select state from invalidations")).toEqual([{ state: "withdrawn" }]);
    expect(rows(workspace, "select state from rework_cycles")).toEqual([{ state: "withdrawn" }]);
    // A withdrawal is terminal, so crew next offers no correction, no review, and no tracker step.
    const next = await nextActions(workspace);
    expect(
      next.actions.filter(
        (one) => one.assignmentId === producer.assignmentId && one.action !== "close_process",
      ),
    ).toEqual([]);
  });

  test("keeps the write paths of withdrawn work held while its commit is on the branch", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace, undefined, { dependents: [OTHER] });
    const other = producer.dependents.get("22.2") ?? "";
    await acceptedResult(workspace, producer);
    // The other item asks for the paths of the producer, and the request names each holder.
    const asked = async () => {
      const inputPath = `${workspace.root}/paths-${crypto.randomUUID()}.json`;
      await Bun.write(inputPath, JSON.stringify({ paths: ["docs/"] }));
      const report = await runJson(workspace, [
        "work",
        "write-paths",
        "--assignment",
        other,
        "--input",
        inputPath,
      ]);
      return report.json.data.grant.overlaps.map(
        (one: { assignmentId: string }) => one.assignmentId,
      );
    };
    // Accepted work holds no paths.
    expect(await asked()).toEqual([]);

    const { registered } = await withdrawIssues(workspaceTarget(workspace), producer.ownerToken, {
      sourceKind: "specification",
      parent: 15,
      numbers: [PRODUCER_ISSUE],
    });
    expect(registered.exitCode).toBe(0);

    // The branch still holds the commit of the withdrawn work, so its paths hold again.
    expect(await asked()).toEqual([producer.assignmentId]);
  });
});
