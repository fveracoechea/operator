import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ContentIdentity } from "../content-identity/main.ts";
import {
  assignmentsOf,
  type FixtureSource,
  type FixtureTarget,
  fakeIssue,
  issueKey,
  planSource,
  readFake,
  registerSource,
  seedSource,
  sourceInput,
  SOURCE_REPOSITORY,
  writeFake,
  writeInput,
} from "./source-fixture.ts";
import { setFault } from "./tracker-fixture.ts";
import {
  ownCrew,
  requestId,
  runJson,
  runOperator,
  type Workspace,
  workspaces,
} from "./workspace-fixture.ts";

// Each test runs several CLI processes against one fixture repository and the GitHub fake.
setDefaultTimeout(60_000);

const fixtures = workspaces();

afterAll(async () => {
  await fixtures.removeAll();
});

const OTHER_REPOSITORY = "fveracoechea/elsewhere";

type Refusal = { reason: string; key: string; blocker?: string; [field: string]: unknown };

function targetOf(workspace: Workspace): FixtureTarget {
  return {
    root: workspace.root,
    github: workspace.github,
    run: (args) => runJson(workspace, args),
  };
}

async function owned(): Promise<{ workspace: Workspace; token: string; target: FixtureTarget }> {
  const workspace = await fixtures.make();
  const token = await ownCrew(workspace);
  return { workspace, token, target: targetOf(workspace) };
}

/** Seeds one source and previews it, as a session does before it asks for the approval. */
async function preview(target: FixtureTarget, source: FixtureSource) {
  const numbers = await seedSource(target.github, source);
  const inputPath = await writeInput(target.root, sourceInput(source, numbers));
  return { plan: await planSource(target, inputPath), inputPath, numbers };
}

async function register(
  workspace: Workspace,
  token: string,
  inputPath: string,
  planRevision: string,
) {
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
    planRevision,
  ]);
}

/** The full plan the preview wrote. Its report gives only the counts and this path. */
async function planFile(workspace: Workspace, plan: { json: { data: { planPath: string } } }) {
  return Bun.file(`${workspace.repo}/${plan.json.data.planPath}`).json();
}

async function refusalsOf(workspace: Workspace, plan: { json: { data: { planPath: string } } }) {
  const held: { refusals: Refusal[] } = await planFile(workspace, plan);
  return held.refusals.map(({ reason, key, blocker }) =>
    blocker === undefined ? { reason, key } : { reason, key, blocker },
  );
}

async function frontierKeys(workspace: Workspace) {
  const frontier = await runJson(workspace, ["work", "frontier"]);
  const keys = (list: Array<{ sourceKey: string }>) => list.map((one) => one.sourceKey);
  return {
    dispatchable: keys(frontier.json.data.dispatchable),
    blocked: keys(frontier.json.data.blocked),
    planning: keys(frontier.json.data.planning),
  };
}

const key = (number: number, repository = SOURCE_REPOSITORY) => issueKey(number, repository);

describe("operator work register", () => {
  test("registers a parent issue with ordered sub-issues and blocking links", async () => {
    const { workspace, token, target } = await owned();
    // The stored sub-issue order is neither the number order nor the order of the input.
    const source: FixtureSource = {
      sourceKind: "specification",
      parent: 93,
      items: [
        { key: "a", issue: 30 },
        { key: "b", issue: 10 },
        { key: "c", issue: 20 },
        { key: "d", issue: 40, dependsOn: [{ key: "a" }] },
      ],
    };

    const { plan, inputPath } = await preview(target, source);
    expect(plan.exitCode).toBe(0);
    expect(plan.json.reason).toBe("registration_planned");
    expect(plan.json.data.counts).toEqual({
      new: 4,
      updated: 0,
      unchanged: 0,
      withdrawn: 0,
      skipped: 0,
      satisfiedBlockers: 0,
      refusals: 0,
    });

    const registered = await register(workspace, token, inputPath, plan.json.data.planRevision);
    expect(registered.exitCode).toBe(0);
    expect(registered.json.data.source.id).toBe(key(93));
    expect((await assignmentsOf(target, key(93))).map((one) => one.sourceKey)).toEqual([
      key(30),
      key(10),
      key(20),
      key(40),
    ]);

    // Two production slots are free under the default crew limit, and the review slot is held.
    expect(await frontierKeys(workspace)).toEqual({
      dispatchable: [key(30), key(10)],
      blocked: [key(20), key(40)],
      planning: [],
    });
  });

  test("takes the approved scope from the issue and the execution fields from the input", async () => {
    const { workspace, token, target } = await owned();
    const registered = await registerSource(target, token, {
      sourceKind: "specification",
      parent: 93,
      items: [
        {
          key: "a",
          issue: 94,
          title: "Build the dispatch path",
          body: "Build it.\r\nNothing else.",
          acceptanceRequirements: ["The dispatch test passes."],
        },
      ],
    });
    expect(registered.exitCode).toBe(0);

    const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`, {
      readonly: true,
    });
    const row = sqlite
      .query(
        "select title, approved_scope, scope_identity, tracker_binding, acceptance_requirements from assignments",
      )
      .get() as {
      title: string;
      approved_scope: string;
      scope_identity: string;
      tracker_binding: string;
      acceptance_requirements: string;
    };
    const source = sqlite.query("select revision, tracker_location from work_sources").get() as {
      revision: string;
      tracker_location: string;
    };
    sqlite.close();

    expect(row.title).toBe("Build the dispatch path");
    expect(row.approved_scope).toBe("Build it.\r\nNothing else.");
    // A line-ending change is no new text, so the identity is taken over LF only.
    expect(row.scope_identity).toBe(
      ContentIdentity.of({ title: "Build the dispatch path", body: "Build it.\nNothing else." }),
    );
    expect(JSON.parse(row.acceptance_requirements)).toEqual(["The dispatch test passes."]);
    expect(JSON.parse(row.tracker_binding)).toEqual({
      repository: SOURCE_REPOSITORY,
      issue: 94,
      issueId: fakeIssue({ number: 94 }).id,
    });
    expect(source.revision).toBe(
      ContentIdentity.of({ title: "Issue 93", body: "The body of issue 93." }),
    );
    expect(JSON.parse(source.tracker_location)).toEqual({
      repository: SOURCE_REPOSITORY,
      mapIssue: null,
      parent: { issue: 93, issueId: fakeIssue({ number: 93 }).id },
    });
  });

  test("registers a ticket as one issue that is its own item", async () => {
    const { workspace, token, target } = await owned();
    const registered = await registerSource(target, token, {
      sourceKind: "ticket",
      parent: 28,
      items: [{ key: "t" }],
    });

    expect(registered.exitCode).toBe(0);
    expect(registered.json.data.source).toMatchObject({ id: key(28), kind: "ticket" });
    expect(registered.assignments.map((one) => one.sourceKey)).toEqual([key(28)]);
    expect((await frontierKeys(workspace)).dispatchable).toEqual([key(28)]);
  });

  test("takes the kind of a wayfinder item from its type label", async () => {
    const { workspace, token, target } = await owned();
    const registered = await registerSource(target, token, {
      sourceKind: "wayfinder",
      parent: 1,
      items: [
        { key: "research", wayfinderType: "research" },
        { key: "task", wayfinderType: "task", dependsOn: [{ key: "research" }] },
      ],
    });

    expect(registered.exitCode).toBe(0);
    expect(registered.assignments.map((one) => one.kind)).toEqual(["planning", "production"]);
    expect(await frontierKeys(workspace)).toEqual({
      dispatchable: [],
      blocked: [key(102)],
      planning: [key(101)],
    });
  });

  test("changes nothing at the preview", async () => {
    const { workspace, target } = await owned();
    const { plan } = await preview(target, {
      sourceKind: "specification",
      parent: 93,
      items: [{ key: "a" }],
    });

    expect(plan.exitCode).toBe(0);
    expect(await frontierKeys(workspace)).toEqual({ dispatchable: [], blocked: [], planning: [] });
  });

  test("gives byte-identical previews of the same tracker content and input", async () => {
    const { workspace, target } = await owned();
    const { inputPath } = await preview(target, {
      sourceKind: "specification",
      parent: 93,
      items: [
        { key: "a", issue: 30 },
        { key: "b", issue: 10, dependsOn: [{ key: "a" }] },
      ],
    });

    const first = await runOperator(workspace, [
      "work",
      "register",
      "--plan",
      "--input",
      inputPath,
      "--json",
    ]);
    const firstFile = await Bun.file(
      `${workspace.repo}/${JSON.parse(first.stdout).data.planPath}`,
    ).text();
    const second = await runOperator(workspace, [
      "work",
      "register",
      "--plan",
      "--input",
      inputPath,
      "--json",
    ]);
    const secondFile = await Bun.file(
      `${workspace.repo}/${JSON.parse(second.stdout).data.planPath}`,
    ).text();

    expect(second.stdout).toBe(first.stdout);
    expect(secondFile).toBe(firstFile);
    const readable = await runOperator(workspace, [
      "work",
      "register",
      "--plan",
      "--input",
      inputPath,
    ]);
    const again = await runOperator(workspace, [
      "work",
      "register",
      "--plan",
      "--input",
      inputPath,
    ]);
    expect(again.stdout).toBe(readable.stdout);
  });

  test("gives a summary and the path of the full plan", async () => {
    const { workspace, target } = await owned();
    const { plan, inputPath } = await preview(target, {
      sourceKind: "specification",
      parent: 93,
      items: [
        { key: "a", issue: 30 },
        { key: "b", issue: 10, dependsOn: [{ key: "a" }] },
      ],
    });

    // The Operator reads this report, so it lists no item and points to the plan file.
    expect(Object.keys(plan.json.data).toSorted()).toEqual([
      "approval",
      "command",
      "counts",
      "planPath",
      "planRevision",
      "source",
    ]);
    expect(plan.json.data.command).toBe(
      `operator work register --request <id> --owner-token <token> --input ${inputPath} --plan-revision ${plan.json.data.planRevision}`,
    );
    const held = await planFile(workspace, plan);
    expect(held.planRevision).toBe(plan.json.data.planRevision);
    expect(held.items.map((one: { key: string }) => one.key)).toEqual([key(30), key(10)]);
    expect(held.items[1].dependsOn).toEqual([{ sourceId: key(93), key: key(30) }]);
  });

  test("reports a registration as counts and points to the frontier", async () => {
    const { workspace, token, target } = await owned();
    const { plan, inputPath } = await preview(target, {
      sourceKind: "specification",
      parent: 93,
      items: [
        { key: "a", issue: 30 },
        { key: "b", issue: 10 },
      ],
    });

    const request = requestId();
    const args = ["work", "register", "--request", request, "--owner-token", token];
    const readable = await runOperator(workspace, [
      ...args,
      "--input",
      inputPath,
      "--plan-revision",
      plan.json.data.planRevision,
    ]);
    const registered = await runJson(workspace, [
      ...args,
      "--input",
      inputPath,
      "--plan-revision",
      plan.json.data.planRevision,
    ]);

    // The Operator reads this report, so it gives counts and points to the frontier.
    expect(registered.json.data.counts).toEqual({ registered: 2, updated: 0, withdrawn: 0 });
    expect(registered.json.data.frontier).toBe("operator work frontier");
    expect(readable.stdout).toContain("List each assignment with: operator work frontier");
    const listed = await assignmentsOf(target, key(93));
    expect(listed).toHaveLength(2);
    for (const one of listed) {
      expect(readable.stdout).not.toContain(one.assignmentId);
      expect(registered.stdout).not.toContain(one.assignmentId);
    }
  });

  test("refuses a changed tracker between the preview and the registration and names it", async () => {
    const { workspace, token, target } = await owned();
    const { plan, inputPath } = await preview(target, {
      sourceKind: "specification",
      parent: 93,
      items: [
        { key: "a", issue: 30 },
        { key: "b", issue: 10 },
      ],
    });

    const state = await readFake(workspace.github);
    const subIssues = state.subIssues?.["93"] ?? [];
    const changed = subIssues.map((one) =>
      one.number === 10 ? { ...one, body: "A changed scope." } : one,
    );
    state.subIssues = { ...state.subIssues, "93": changed };
    state.issues["93"] = { ...fakeIssue({ number: 93 }), body: "A changed parent." };
    await writeFake(workspace.github, state);

    const refused = await register(workspace, token, inputPath, plan.json.data.planRevision);

    expect(refused.exitCode).toBe(4);
    expect(refused.json.reason).toBe("plan_revision_changed");
    expect(refused.json.blockers[0].requested).toBe(plan.json.data.planRevision);
    expect(refused.json.blockers[0].differences).toEqual([
      { part: "source", key: key(93), change: "changed" },
      { part: "item", key: key(10), change: "changed" },
    ]);
    expect(await frontierKeys(workspace)).toEqual({ dispatchable: [], blocked: [], planning: [] });
  });

  test("refuses a changed input between the preview and the registration and names it", async () => {
    const { workspace, token, target } = await owned();
    const source: FixtureSource = {
      sourceKind: "specification",
      parent: 93,
      items: [{ key: "a", issue: 30 }],
    };
    const { plan, numbers } = await preview(target, source);
    const changed = await writeInput(
      workspace.root,
      sourceInput(
        { ...source, items: [{ key: "a", issue: 30, acceptanceRequirements: ["Another one."] }] },
        numbers,
      ),
    );

    const refused = await register(workspace, token, changed, plan.json.data.planRevision);

    expect(refused.json.reason).toBe("plan_revision_changed");
    expect(refused.json.blockers[0].differences).toEqual([
      { part: "input", key: key(30), change: "changed" },
    ]);
  });

  test("refuses a registration that names no plan revision", async () => {
    const { workspace, token, target } = await owned();
    const { inputPath } = await preview(target, {
      sourceKind: "specification",
      parent: 93,
      items: [{ key: "a" }],
    });

    const refused = await runJson(workspace, [
      "work",
      "register",
      "--request",
      requestId(),
      "--owner-token",
      token,
      "--input",
      inputPath,
    ]);

    expect(refused.exitCode).toBe(2);
    expect(refused.json.reason).toBe("invalid_arguments");
  });

  test("reports every refusal at once, in item order and then by blocker key", async () => {
    const { workspace, token, target } = await owned();
    const state = await readFake(workspace.github);
    state.issues["900"] = fakeIssue({ number: 900 });
    state.issues["800"] = fakeIssue({ number: 800 });
    await writeFake(workspace.github, state);
    const source: FixtureSource = {
      sourceKind: "specification",
      parent: 93,
      items: [
        { key: "a", issue: 30, inInput: false },
        {
          key: "b",
          issue: 10,
          permissions: { writePaths: [], allowedCommands: [], network: false },
        },
        { key: "c", issue: 20 },
      ],
    };
    const numbers = await seedSource(workspace.github, source);
    const held = await readFake(workspace.github);
    held.blockedBy = {
      ...held.blockedBy,
      "20": [held.issues["900"], held.issues["800"]].filter((one) => one !== undefined),
    };
    await writeFake(workspace.github, held);
    const input = sourceInput(source, numbers);
    const inputPath = await writeInput(workspace.root, {
      ...input,
      items: [...input.items, { ...input.items[0], issue: key(77) }],
    });

    const plan = await planSource(target, inputPath);

    const expected = [
      { reason: "input_issue_missing", key: key(30) },
      { reason: "write_paths_required", key: key(10) },
      { reason: "blocker_unregistered", key: key(20), blocker: key(800) },
      { reason: "blocker_unregistered", key: key(20), blocker: key(900) },
      { reason: "input_issue_outside_source", key: key(77) },
    ];
    expect(plan.exitCode).toBe(2);
    expect(plan.json.reason).toBe("registration_refused");
    expect(plan.json.data.command).toBeNull();
    expect(plan.json.blockers).toEqual([
      { reason: "input_issue_missing", count: 1 },
      { reason: "write_paths_required", count: 1 },
      { reason: "blocker_unregistered", count: 2 },
      { reason: "input_issue_outside_source", count: 1 },
    ]);
    expect(await refusalsOf(workspace, plan)).toEqual(expected);

    // The registration reports the same refusals, and records nothing.
    const refused = await register(workspace, token, inputPath, plan.json.data.planRevision);
    expect(refused.json.reason).toBe("registration_refused");
    expect(await refusalsOf(workspace, refused)).toEqual(expected);
    expect(await frontierKeys(workspace)).toEqual({ dispatchable: [], blocked: [], planning: [] });
  });
});

describe("work register refusals", () => {
  test("refuses an input that names an issue outside the source", async () => {
    const { workspace, target } = await owned();
    const source: FixtureSource = {
      sourceKind: "specification",
      parent: 93,
      items: [{ key: "a" }],
    };
    const numbers = await seedSource(workspace.github, source);
    const input = sourceInput(source, numbers);
    const inputPath = await writeInput(workspace.root, {
      ...input,
      items: [...input.items, { ...input.items[0], issue: key(5) }],
    });

    const plan = await planSource(target, inputPath);

    expect(await refusalsOf(workspace, plan)).toEqual([
      { reason: "input_issue_outside_source", key: key(5) },
    ]);
  });

  test("refuses an input that leaves out a sub-issue", async () => {
    const { workspace, target } = await owned();
    const { plan } = await preview(target, {
      sourceKind: "specification",
      parent: 93,
      items: [{ key: "a" }, { key: "b", inInput: false }],
    });

    expect(await refusalsOf(workspace, plan)).toEqual([
      { reason: "input_issue_missing", key: key(9302) },
    ]);
  });

  test("refuses an executable item in another repository and registers a planning item there", async () => {
    const { workspace, token, target } = await owned();
    const { plan } = await preview(target, {
      sourceKind: "specification",
      parent: 93,
      items: [
        { key: "code", issue: 501, repository: OTHER_REPOSITORY },
        { key: "plan", issue: 502, repository: OTHER_REPOSITORY, kind: "planning" },
      ],
    });
    expect(await refusalsOf(workspace, plan)).toEqual([
      { reason: "executable_item_in_other_repository", key: key(501, OTHER_REPOSITORY) },
    ]);

    const registered = await registerSource(target, token, {
      sourceKind: "specification",
      parent: 94,
      items: [
        { key: "plan", issue: 503, repository: OTHER_REPOSITORY, kind: "planning" },
        { key: "code", issue: 504, dependsOn: [{ key: "plan" }] },
      ],
    });
    expect(registered.exitCode).toBe(0);
    expect(await frontierKeys(workspace)).toEqual({
      dispatchable: [],
      blocked: [key(504)],
      planning: [key(503, OTHER_REPOSITORY)],
    });
  });

  test("refuses an open blocker that no registered source holds", async () => {
    const { workspace, target } = await owned();
    const state = await readFake(workspace.github);
    state.issues["700"] = fakeIssue({ number: 700 });
    await writeFake(workspace.github, state);
    const source: FixtureSource = {
      sourceKind: "specification",
      parent: 93,
      items: [{ key: "a" }],
    };
    const numbers = await seedSource(workspace.github, source);
    const held = await readFake(workspace.github);
    held.blockedBy = { ...held.blockedBy, "9301": [fakeIssue({ number: 700 })] };
    await writeFake(workspace.github, held);
    const inputPath = await writeInput(workspace.root, sourceInput(source, numbers));

    const plan = await planSource(target, inputPath);

    expect(await refusalsOf(workspace, plan)).toEqual([
      { reason: "blocker_unregistered", key: key(9301), blocker: key(700) },
    ]);
  });

  test("names a closed blocker as satisfied and does not register a closed sub-issue", async () => {
    const { workspace, token, target } = await owned();
    const source: FixtureSource = {
      sourceKind: "specification",
      parent: 93,
      items: [
        { key: "done", issue: 30, state: "closed" },
        { key: "next", issue: 31, dependsOn: [{ key: "done" }] },
      ],
    };
    const numbers = await seedSource(workspace.github, source);
    const held = await readFake(workspace.github);
    held.blockedBy = {
      ...held.blockedBy,
      "31": [
        fakeIssue({ number: 30, state: "closed" }),
        fakeIssue({ number: 701, state: "closed" }),
      ],
    };
    await writeFake(workspace.github, held);
    const inputPath = await writeInput(workspace.root, sourceInput(source, numbers));

    const plan = await planSource(target, inputPath);
    expect(plan.json.data.counts).toEqual({
      new: 1,
      updated: 0,
      unchanged: 0,
      withdrawn: 0,
      skipped: 1,
      satisfiedBlockers: 2,
      refusals: 0,
    });
    const file = await planFile(workspace, plan);
    expect(file.satisfiedBlockers).toEqual([
      { key: key(31), blocker: key(30) },
      { key: key(31), blocker: key(701) },
    ]);
    expect(file.skipped).toEqual([{ key: key(30), position: 0 }]);

    const registered = await register(workspace, token, inputPath, plan.json.data.planRevision);
    expect(registered.exitCode).toBe(0);
    expect((await frontierKeys(workspace)).dispatchable).toEqual([key(31)]);
  });

  test("refuses a production item blocked by an open production item of another source", async () => {
    const { workspace, token, target } = await owned();
    const first = await registerSource(target, token, {
      sourceKind: "specification",
      parent: 15,
      items: [
        { key: "code", issue: 150 },
        { key: "research", issue: 151, kind: "planning" },
      ],
    });
    expect(first.exitCode).toBe(0);

    const { plan } = await preview(target, {
      sourceKind: "specification",
      parent: 16,
      items: [
        { key: "late", issue: 160, dependsOn: [{ sourceId: "x#15", key: "code" }] },
        {
          key: "planned",
          issue: 161,
          kind: "planning",
          dependsOn: [{ sourceId: "x#15", key: "code" }],
        },
        { key: "informed", issue: 162, dependsOn: [{ sourceId: "x#15", key: "research" }] },
      ],
    });

    const file = await planFile(workspace, plan);
    expect(file.refusals).toEqual([
      {
        reason: "blocker_in_other_source",
        key: key(160),
        blocker: key(150),
        sourceId: key(15),
        assignmentId: first.keys.get("code"),
      },
    ]);
    // A planning dependent, and a dependency on planning work, cross sources freely.
    expect(file.items.map((one: { key: string; dependsOn: unknown }) => one.dependsOn)).toEqual([
      [],
      [{ sourceId: key(15), key: key(150) }],
      [{ sourceId: key(15), key: key(151) }],
    ]);
  });

  test("refuses a parent with no sub-issues", async () => {
    const { workspace, target } = await owned();
    const { plan } = await preview(target, { sourceKind: "specification", parent: 93, items: [] });

    expect(await refusalsOf(workspace, plan)).toEqual([
      { reason: "source_without_items", key: key(93) },
    ]);
  });

  test("refuses a read that did not cover every sub-issue", async () => {
    const { workspace, target } = await owned();
    const source: FixtureSource = {
      sourceKind: "specification",
      parent: 93,
      items: [{ key: "a" }],
    };
    const numbers = await seedSource(workspace.github, source);
    const inputPath = await writeInput(workspace.root, sourceInput(source, numbers));
    await setFault(workspace, "readSubIssues", "status:502");

    const plan = await planSource(target, inputPath);

    expect(plan.json.reason).toBe("registration_refused");
    expect((await refusalsOf(workspace, plan))[0]).toEqual({
      reason: "tracker_read_incomplete",
      key: key(93),
    });
    // The sub-issue the read never saw is still named, so the input is not taken as complete.
    expect(await refusalsOf(workspace, plan)).toContainEqual({
      reason: "input_issue_outside_source",
      key: key(9301),
    });
  });

  test("refuses a read that did not cover every blocker set", async () => {
    const { workspace, target } = await owned();
    const source: FixtureSource = {
      sourceKind: "specification",
      parent: 93,
      items: [{ key: "a" }],
    };
    const numbers = await seedSource(workspace.github, source);
    const inputPath = await writeInput(workspace.root, sourceInput(source, numbers));
    await setFault(workspace, "readBlockedBy", "status:502");

    const plan = await planSource(target, inputPath);

    const file = await planFile(workspace, plan);
    expect(file.refusals).toHaveLength(1);
    expect(file.refusals[0]).toMatchObject({
      reason: "tracker_read_incomplete",
      key: key(9301),
      list: "blockers",
    });
  });

  test("refuses a source whose parent issue does not exist", async () => {
    const { workspace, target } = await owned();
    const inputPath = await writeInput(workspace.root, {
      sourceKind: "specification",
      source: key(404),
      items: [],
    });

    const plan = await planSource(target, inputPath);

    expect(await refusalsOf(workspace, plan)).toEqual([
      { reason: "source_not_found", key: key(404) },
    ]);
  });

  test("refuses a wayfinder item whose kind the input contradicts or whose label is missing", async () => {
    const { workspace, target } = await owned();
    const { plan } = await preview(target, {
      sourceKind: "wayfinder",
      parent: 1,
      items: [
        { key: "research", wayfinderType: "research", kind: "production" },
        { key: "unlabelled" },
      ],
    });

    expect(await refusalsOf(workspace, plan)).toEqual([
      { reason: "item_kind_contradicted", key: key(101) },
      { reason: "wayfinder_type_unreadable", key: key(102) },
    ]);
  });

  test("refuses a source whose key is registered from another parent issue", async () => {
    const { workspace, token, target } = await owned();
    const source: FixtureSource = {
      sourceKind: "specification",
      parent: 93,
      items: [{ key: "a" }],
    };
    expect((await registerSource(target, token, source)).exitCode).toBe(0);
    // A new read matches a registered source by the database id of its parent issue.
    const state = await readFake(workspace.github);
    state.issues["93"] = { ...fakeIssue({ number: 93 }), id: 1 };
    await writeFake(workspace.github, state);

    const numbers = new Map([["a", 9301]]);
    const plan = await planSource(
      target,
      await writeInput(target.root, sourceInput(source, numbers)),
    );

    expect(await refusalsOf(workspace, plan)).toEqual([
      { reason: "source_already_registered", key: key(93) },
      { reason: "issue_already_registered", key: key(9301) },
    ]);
  });

  test("refuses a new read of a source an earlier release registered with no parent issue", async () => {
    const { workspace, target } = await owned();
    const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`);
    sqlite
      .query(
        `insert into work_sources (id, kind, revision, tracker, tracker_location, order_index, registered_at)
         values ('github:operator#1', 'wayfinder', 'rev-1', 'github', ?, 0, 'then')`,
      )
      .run(JSON.stringify({ repository: SOURCE_REPOSITORY, mapIssue: 1 }));
    sqlite.close();

    const { plan } = await preview(target, {
      sourceKind: "wayfinder",
      parent: 1,
      items: [{ key: "task", wayfinderType: "task" }],
    });

    expect(await refusalsOf(workspace, plan)).toEqual([
      { reason: "source_recorded_without_parent", key: key(1) },
    ]);
  });

  test("refuses a path fixed input whose file the checkout does not hold as stated", async () => {
    const { workspace, target } = await owned();
    await Bun.write(`${workspace.repo}/docs/spec.md`, "the spec\n", { createPath: true });
    const { plan } = await preview(target, {
      sourceKind: "specification",
      parent: 93,
      items: [
        {
          key: "a",
          fixedInputs: [
            { name: "spec", kind: "path", value: "docs/spec.md", contentIdentity: "f".repeat(64) },
            { name: "gone", kind: "path", value: "docs/gone.md", contentIdentity: "e".repeat(64) },
          ],
        },
      ],
    });

    const file = await planFile(workspace, plan);
    expect(file.refusals).toEqual([
      {
        reason: "fixed_input_mismatch",
        key: key(9301),
        name: "spec",
        path: "docs/spec.md",
        statedIdentity: "f".repeat(64),
        foundIdentity: ContentIdentity.ofText("the spec\n"),
      },
      {
        reason: "fixed_input_mismatch",
        key: key(9301),
        name: "gone",
        path: "docs/gone.md",
        statedIdentity: "e".repeat(64),
        foundIdentity: null,
      },
    ]);
  });

  test("reads a link that leads out of the checkout as a file the checkout does not hold", async () => {
    const { workspace, target } = await owned();
    await Bun.write(`${workspace.root}/outside.md`, "outside\n");
    await Bun.$`mkdir -p ${workspace.repo}/docs && ln -s ${workspace.root}/outside.md ${workspace.repo}/docs/link.md`.quiet();
    const { plan } = await preview(target, {
      sourceKind: "specification",
      parent: 93,
      items: [
        {
          key: "a",
          fixedInputs: [
            {
              name: "link",
              kind: "path",
              value: "docs/link.md",
              contentIdentity: ContentIdentity.ofText("outside\n"),
            },
          ],
        },
      ],
    });

    const file = await planFile(workspace, plan);
    expect(file.refusals).toEqual([
      expect.objectContaining({ reason: "fixed_input_mismatch", foundIdentity: null }),
    ]);
  });

  test("refuses a dependency cycle that the blocking links form", async () => {
    const { workspace, target } = await owned();
    const source: FixtureSource = {
      sourceKind: "specification",
      parent: 93,
      items: [{ key: "a" }, { key: "b", dependsOn: [{ key: "a" }] }],
    };
    const numbers = await seedSource(workspace.github, source);
    const held = await readFake(workspace.github);
    held.blockedBy = { ...held.blockedBy, "9301": [fakeIssue({ number: 9302 })] };
    await writeFake(workspace.github, held);
    const inputPath = await writeInput(workspace.root, sourceInput(source, numbers));

    const plan = await planSource(target, inputPath);

    const file = await planFile(workspace, plan);
    expect(file.refusals).toEqual([
      { reason: "dependency_cycle", key: key(9301), cycle: [key(9301), key(9302), key(9301)] },
    ]);
  });
});

describe("work register input", () => {
  test("refuses an input that carries a structure field", async () => {
    const { workspace, target } = await owned();
    const source: FixtureSource = {
      sourceKind: "specification",
      parent: 93,
      items: [{ key: "a" }],
    };
    const numbers = await seedSource(workspace.github, source);
    const input = sourceInput(source, numbers);

    for (const structure of [
      { title: "A title" },
      { approvedScope: "A scope" },
      { dependsOn: [] },
      { key: "93.1" },
      { trackerIssue: 9301 },
    ]) {
      const inputPath = await writeInput(workspace.root, {
        ...input,
        items: [{ ...input.items[0], ...structure }],
      });
      const refused = await planSource(target, inputPath);
      expect(refused.exitCode).toBe(2);
      expect(refused.json.reason).toBe("invalid_work_input");
    }
  });

  test("refuses the hand-written structure an earlier release read", async () => {
    const { workspace, target } = await owned();
    const inputPath = await writeInput(workspace.root, {
      sourceKind: "specification",
      source: { id: "github:operator#15", revision: "rev-1", tracker: "github" },
      items: [],
    });

    const refused = await planSource(target, inputPath);

    expect(refused.exitCode).toBe(2);
    expect(refused.json.reason).toBe("invalid_work_input");
  });

  test("refuses an input that names one issue twice", async () => {
    const { workspace, target } = await owned();
    const source: FixtureSource = {
      sourceKind: "specification",
      parent: 93,
      items: [{ key: "a" }],
    };
    const numbers = await seedSource(workspace.github, source);
    const input = sourceInput(source, numbers);
    const inputPath = await writeInput(workspace.root, {
      ...input,
      items: [input.items[0], { ...input.items[0], issue: key(9301).toUpperCase() }],
    });

    const refused = await planSource(target, inputPath);

    expect(refused.json.reason).toBe("invalid_work_input");
  });

  test("refuses a preview that carries a mutation flag", async () => {
    const { workspace, token, target } = await owned();
    const { inputPath } = await preview(target, {
      sourceKind: "specification",
      parent: 93,
      items: [{ key: "a" }],
    });

    const refused = await runJson(workspace, [
      "work",
      "register",
      "--plan",
      "--input",
      inputPath,
      "--owner-token",
      token,
    ]);

    expect(refused.json.reason).toBe("invalid_arguments");
  });
});
