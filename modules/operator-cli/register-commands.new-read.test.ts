import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  type FixtureSource,
  type FixtureTarget,
  issueKey,
  planSource,
  readFake,
  registerSource,
  seedSource,
  sourceInput,
  writeFake,
  writeInput,
} from "./source-fixture.ts";
import type { FakeIssue } from "./github-fake-state.ts";
import { ownCrew, requestId, runJson, type Workspace, workspaces } from "./workspace-fixture.ts";

// Each test runs several CLI processes against one fixture repository and the GitHub fake.
setDefaultTimeout(60_000);

const fixtures = workspaces();

afterAll(async () => {
  await fixtures.removeAll();
});

const key = (number: number) => issueKey(number);
const SOURCE = key(93);

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

/** Two independent production items under one parent, registered as a session does. */
const FIRST: FixtureSource = {
  sourceKind: "specification",
  parent: 93,
  items: [
    { key: "a", issue: 30 },
    { key: "b", issue: 10 },
  ],
};

/** Previews a new read whose input names only the given items. */
async function previewOnly(
  target: FixtureTarget,
  source: FixtureSource,
  named: string[],
  options: { seed?: boolean } = {},
) {
  const numbers =
    options.seed === false
      ? new Map(source.items.map((item) => [item.key, item.issue ?? 0]))
      : await seedSource(target.github, source);
  const input = sourceInput(
    { ...source, items: source.items.filter((item) => named.includes(item.key)) },
    numbers,
  );
  const inputPath = await writeInput(target.root, input);
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

/** Accepts one planning item with a record of one answer of the person. */
async function acceptPlanning(workspace: Workspace, token: string, assignmentId: string) {
  const inputPath = await writeInput(workspace.root, {
    entries: [
      {
        question: "Which library parses the feed?",
        escalationTriggers: [],
        authority: "human-answer",
        exactText: "The standard library.",
        interpretation: {
          summary: "Parse the feed with the standard library.",
          directives: ["Use the standard library parser."],
          appliesTo: ["The feed parser."],
        },
      },
    ],
    artifacts: [],
  });
  return runJson(workspace, [
    "work",
    "accept",
    "--request",
    requestId(),
    "--owner-token",
    token,
    "--assignment",
    assignmentId,
    "--revision",
    "1",
    "--input",
    inputPath,
  ]);
}

/** Sets one recorded state, for a state that no short command path reaches. */
function setState(workspace: Workspace, assignmentId: string, state: string) {
  const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`);
  try {
    sqlite.query("update assignments set state = ? where id = ?").run(state, assignmentId);
  } finally {
    sqlite.close();
  }
}

/** The recorded dependencies of one assignment. */
function dependenciesOf(workspace: Workspace, assignmentId: string): string[] {
  const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`, {
    readonly: true,
  });
  try {
    const rows = sqlite
      .query("select depends_on_id from assignment_dependencies where assignment_id = ?")
      .all(assignmentId) as Array<{ depends_on_id: string }>;
    return rows.map((one) => one.depends_on_id);
  } finally {
    sqlite.close();
  }
}

async function planFile(workspace: Workspace, plan: { json: { data: { planPath: string } } }) {
  return Bun.file(`${workspace.repo}/${plan.json.data.planPath}`).json();
}

async function refusalsOf(workspace: Workspace, plan: { json: { data: { planPath: string } } }) {
  const held: { refusals: Refusal[] } = await planFile(workspace, plan);
  return held.refusals;
}

/** Changes one issue everywhere the fake holds it, as an edit on GitHub does. */
async function editIssue(github: string, number: number, change: Partial<FakeIssue>) {
  const state = await readFake(github);
  const edit = (one: FakeIssue) => (one.number === number ? { ...one, ...change } : one);
  const held = state.issues[String(number)];
  if (held !== undefined) {
    state.issues[String(number)] = edit(held);
  }
  state.subIssues = Object.fromEntries(
    Object.entries(state.subIssues ?? {}).map(([parent, list]) => [parent, list.map(edit)]),
  );
  state.blockedBy = Object.fromEntries(
    Object.entries(state.blockedBy ?? {}).map(([issue, list]) => [issue, list.map(edit)]),
  );
  await writeFake(github, state);
}

/** Reads recorded rows directly, because no command reports a source revision per assignment. */
function recorded(workspace: Workspace) {
  const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`, {
    readonly: true,
  });
  try {
    return {
      sources: sqlite
        .query("select id, revision from work_sources order by order_index")
        .all() as Array<{
        id: string;
        revision: string;
      }>,
      assignments: sqlite
        .query(
          "select source_key, source_revision, title, approved_scope, acceptance_requirements, order_index, revision from assignments order by order_index",
        )
        .all() as Array<{
        source_key: string;
        source_revision: string;
        title: string;
        approved_scope: string;
        acceptance_requirements: string;
        order_index: number;
        revision: number;
      }>,
    };
  } finally {
    sqlite.close();
  }
}

describe("a new read of a registered source", () => {
  test("adds a new sub-issue at its stored position with no approval", async () => {
    const { workspace, token, target } = await owned();
    expect((await registerSource(target, token, FIRST)).exitCode).toBe(0);

    const grown: FixtureSource = {
      ...FIRST,
      items: [
        { key: "a", issue: 30 },
        { key: "c", issue: 50 },
        { key: "b", issue: 10 },
      ],
    };
    const { plan, inputPath } = await previewOnly(target, grown, ["c"]);

    expect(plan.json.reason).toBe("registration_planned");
    expect(plan.json.data.counts).toEqual({
      new: 1,
      updated: 0,
      unchanged: 2,
      skipped: 0,
      satisfiedBlockers: 0,
      refusals: 0,
    });
    // Only a changed source or a changed item needs the person.
    expect(plan.json.data.approval).toBeNull();
    const held = await planFile(workspace, plan);
    expect(held.items.map((one: { key: string; change: string }) => [one.key, one.change])).toEqual(
      [
        [key(30), "unchanged"],
        [key(50), "new"],
        [key(10), "unchanged"],
      ],
    );

    const registered = await register(workspace, token, inputPath, plan.json.data.planRevision);
    expect(registered.exitCode).toBe(0);
    expect(
      registered.json.data.registered.map((one: { sourceKey: string }) => one.sourceKey),
    ).toEqual([key(50)]);
    expect(registered.json.data.updated).toEqual([]);
    expect(registered.json.data.counts).toEqual({ registered: 1, updated: 0 });
    expect(recorded(workspace).assignments.map((one) => [one.source_key, one.order_index])).toEqual(
      [
        [key(30), 0],
        [key(50), 1],
        [key(10), 2],
      ],
    );
  });

  test("records a changed parent body only behind the approval, and started work keeps its revision", async () => {
    const { workspace, token, target } = await owned();
    const first = await registerSource(target, token, FIRST);
    const before = recorded(workspace).sources[0]?.revision ?? "";
    expect((await claim(workspace, token, first.keys.get("a") ?? "")).exitCode).toBe(0);

    await editIssue(workspace.github, 93, { body: "A changed destination." });
    const grown: FixtureSource = {
      ...FIRST,
      items: [...FIRST.items, { key: "c", issue: 50 }],
    };
    const { plan, inputPath } = await previewOnly(target, grown, ["c"]);
    expect(plan.json.reason).toBe("registration_planned");
    expect(plan.json.data.source.change).toBe("changed");
    const approval = {
      action: "registration-change",
      targets: [SOURCE],
      scope: SOURCE,
      requestRevision: plan.json.data.planRevision,
    };
    expect(plan.json.data.approval).toEqual(approval);

    // An approval of another plan revision covers nothing.
    expect(
      (await grant(workspace, token, { ...approval, requestRevision: "0".repeat(64) })).exitCode,
    ).toBe(0);
    const refused = await register(workspace, token, inputPath, plan.json.data.planRevision);
    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("approval_required");
    expect(refused.json.blockers).toEqual([{ reason: "approval_required", approval }]);
    expect(recorded(workspace).sources[0]?.revision).toBe(before);
    expect(recorded(workspace).assignments).toHaveLength(2);

    expect((await grant(workspace, token, approval)).exitCode).toBe(0);
    const registered = await register(workspace, token, inputPath, plan.json.data.planRevision);
    expect(registered.exitCode).toBe(0);

    const after = recorded(workspace);
    const revision = after.sources[0]?.revision ?? "";
    expect(revision).not.toBe(before);
    expect(after.assignments.map((one) => [one.source_key, one.source_revision])).toEqual([
      [key(30), before],
      [key(10), before],
      [key(50), revision],
    ]);
  });

  test("gives a changed item with no attempt its new content behind the approval", async () => {
    const { workspace, token, target } = await owned();
    await registerSource(target, token, FIRST);
    const before = recorded(workspace).sources[0]?.revision ?? "";

    await editIssue(workspace.github, 10, { title: "A sharper title", body: "A sharper scope." });
    await editIssue(workspace.github, 93, { body: "A changed destination." });
    const changed: FixtureSource = {
      ...FIRST,
      items: [
        { key: "a", issue: 30 },
        { key: "b", issue: 10, acceptanceRequirements: ["The sharper scope holds."] },
      ],
    };
    const { plan, inputPath } = await previewOnly(target, changed, ["b"], { seed: false });
    expect(plan.json.data.counts).toMatchObject({ new: 0, updated: 1, unchanged: 1, refusals: 0 });
    expect(plan.json.data.source.change).toBe("changed");
    expect(plan.json.data.approval?.targets).toEqual([SOURCE]);

    const refused = await register(workspace, token, inputPath, plan.json.data.planRevision);
    expect(refused.json.reason).toBe("approval_required");

    await grant(workspace, token, plan.json.data.approval);
    const registered = await register(workspace, token, inputPath, plan.json.data.planRevision);
    expect(registered.exitCode).toBe(0);
    expect(registered.json.data.updated.map((one: { sourceKey: string }) => one.sourceKey)).toEqual(
      [key(10)],
    );
    expect(registered.json.data.counts).toEqual({ registered: 0, updated: 1 });
    const b = recorded(workspace).assignments.find((one) => one.source_key === key(10));
    expect(b?.title).toBe("A sharper title");
    expect(b?.approved_scope).toBe("A sharper scope.");
    expect(JSON.parse(b?.acceptance_requirements ?? "[]")).toEqual(["The sharper scope holds."]);
    expect(b?.revision).toBe(2);
    // The updated item takes the new source revision, and the unchanged one keeps its own.
    const after = recorded(workspace);
    const revision = after.sources[0]?.revision ?? "";
    expect(revision).not.toBe(before);
    expect(after.assignments.map((one) => [one.source_key, one.source_revision])).toEqual([
      [key(30), before],
      [key(10), revision],
    ]);
  });

  test("names a changed item whose input entry is missing", async () => {
    const { workspace, token, target } = await owned();
    await registerSource(target, token, FIRST);

    await editIssue(workspace.github, 10, { body: "A sharper scope." });
    const { plan } = await previewOnly(target, FIRST, [], { seed: false });

    expect(await refusalsOf(workspace, plan)).toEqual([
      { reason: "input_issue_missing", key: key(10) },
    ]);
  });

  test("refuses a new dependency cycle of a changed item", async () => {
    const { workspace, token, target } = await owned();
    await registerSource(target, token, {
      ...FIRST,
      items: [
        { key: "a", issue: 30 },
        { key: "b", issue: 10, dependsOn: [{ key: "a" }] },
      ],
    });

    const looped: FixtureSource = {
      ...FIRST,
      items: [
        { key: "a", issue: 30, dependsOn: [{ key: "b" }] },
        { key: "b", issue: 10, dependsOn: [{ key: "a" }] },
      ],
    };
    const { plan } = await previewOnly(target, looped, ["a"]);

    expect(plan.json.reason).toBe("registration_refused");
    expect(await refusalsOf(workspace, plan)).toEqual([
      { reason: "dependency_cycle", key: key(10), cycle: [key(10), key(30), key(10)] },
    ]);
  });

  test("refuses and names a changed item that has an attempt", async () => {
    const { workspace, token, target } = await owned();
    const first = await registerSource(target, token, FIRST);
    const a = first.keys.get("a") ?? "";
    await claim(workspace, token, a);

    await editIssue(workspace.github, 30, { body: "A changed scope after the claim." });
    const { plan } = await previewOnly(target, FIRST, ["a"], { seed: false });

    expect(plan.json.reason).toBe("registration_refused");
    expect(await refusalsOf(workspace, plan)).toEqual([
      { reason: "recorded_item_changed", key: key(30), assignmentId: a, state: "claimed" },
    ]);
  });

  test("refuses a changed input entry of an item that has an attempt", async () => {
    const { workspace, token, target } = await owned();
    const first = await registerSource(target, token, FIRST);
    const a = first.keys.get("a") ?? "";
    await claim(workspace, token, a);

    const changed: FixtureSource = {
      ...FIRST,
      items: [
        { key: "a", issue: 30, acceptanceRequirements: ["Another requirement."] },
        { key: "b", issue: 10 },
      ],
    };
    const { plan } = await previewOnly(target, changed, ["a"], { seed: false });

    expect(await refusalsOf(workspace, plan)).toEqual([
      { reason: "recorded_item_changed", key: key(30), assignmentId: a, state: "claimed" },
    ]);
  });

  test("keeps one item for an issue whose repository was renamed", async () => {
    const { workspace, token, target } = await owned();
    await registerSource(target, token, FIRST);

    const renamed = "fveracoechea/operator-renamed";
    for (const number of [93, 30, 10]) {
      await editIssue(workspace.github, number, {
        repository_url: `https://api.github.com/repos/${renamed}`,
      });
    }
    const input = await writeInput(workspace.root, {
      sourceKind: "specification",
      source: issueKey(93, renamed),
      items: [],
    });
    const plan = await planSource(target, input);

    expect(plan.json.reason).toBe("registration_planned");
    expect(plan.json.data.source.id).toBe(SOURCE);
    expect(plan.json.data.counts).toMatchObject({ new: 0, updated: 0, unchanged: 2 });
    expect(plan.json.data.approval).toBeNull();

    const registered = await register(workspace, token, input, plan.json.data.planRevision);
    expect(registered.exitCode).toBe(0);
    expect(recorded(workspace).assignments.map((one) => one.source_key)).toEqual([
      key(30),
      key(10),
    ]);
    expect(recorded(workspace).sources.map((one) => one.id)).toEqual([SOURCE]);
  });

  test("refuses a closed item that is not accepted, with the hint", async () => {
    const { workspace, token, target } = await owned();
    const first = await registerSource(target, token, FIRST);

    await editIssue(workspace.github, 10, { state: "closed" });
    const { plan } = await previewOnly(target, FIRST, [], { seed: false });

    expect(await refusalsOf(workspace, plan)).toEqual([
      {
        reason: "recorded_item_closed",
        key: key(10),
        assignmentId: first.keys.get("b"),
        state: "registered",
        hint: "remove it from its parent to withdraw it, or reopen it",
      },
    ]);
  });

  test("refuses a recorded item that the read does not find", async () => {
    const { workspace, token, target } = await owned();
    const first = await registerSource(target, token, FIRST);

    const state = await readFake(workspace.github);
    state.subIssues = {
      ...state.subIssues,
      "93": (state.subIssues?.["93"] ?? []).filter((one) => one.number !== 10),
    };
    await writeFake(workspace.github, state);
    const { plan } = await previewOnly(target, FIRST, [], { seed: false });

    expect(await refusalsOf(workspace, plan)).toEqual([
      { reason: "recorded_item_missing", key: key(10), assignmentId: first.keys.get("b") },
    ]);
  });

  test("refuses a new read that names another source kind", async () => {
    const { workspace, token, target } = await owned();
    await registerSource(target, token, FIRST);

    const input = await writeInput(workspace.root, {
      sourceKind: "wayfinder",
      source: SOURCE,
      items: [],
    });
    const plan = await planSource(target, input);

    expect((await refusalsOf(workspace, plan))[0]).toEqual({
      reason: "source_kind_changed",
      key: SOURCE,
      recorded: "specification",
      stated: "wayfinder",
    });
  });

  test("refuses a changed item that is registered again after an attempt", async () => {
    const { workspace, token, target } = await owned();
    const first = await registerSource(target, token, FIRST);
    const a = first.keys.get("a") ?? "";
    expect((await claim(workspace, token, a)).exitCode).toBe(0);
    // The attempt row stays. Only the state of the item is back to registered.
    setState(workspace, a, "registered");

    await editIssue(workspace.github, 30, { body: "A changed scope after the attempt." });
    const { plan } = await previewOnly(target, FIRST, ["a"], { seed: false });

    expect(plan.json.reason).toBe("registration_refused");
    expect(await refusalsOf(workspace, plan)).toEqual([
      { reason: "recorded_item_changed", key: key(30), assignmentId: a, state: "registered" },
    ]);
  });

  test("refuses a changed item that is accepted and has no attempt", async () => {
    const { workspace, token, target } = await owned();
    const planning: FixtureSource = {
      ...FIRST,
      items: [
        { key: "a", issue: 30, kind: "planning" },
        { key: "b", issue: 10 },
      ],
    };
    const first = await registerSource(target, token, planning);
    const a = first.keys.get("a") ?? "";
    expect((await acceptPlanning(workspace, token, a)).json.reason).toBe("assignment_accepted");

    await editIssue(workspace.github, 30, { body: "A changed decision after the acceptance." });
    const { plan } = await previewOnly(target, planning, ["a"], { seed: false });

    expect(plan.json.reason).toBe("registration_refused");
    expect(await refusalsOf(workspace, plan)).toEqual([
      { reason: "recorded_item_changed", key: key(30), assignmentId: a, state: "accepted" },
    ]);
  });

  test("keeps the recorded dependency of a changed item on a blocker that closed", async () => {
    const { workspace, token, target } = await owned();
    const source: FixtureSource = {
      ...FIRST,
      items: [
        { key: "a", issue: 30, dependsOn: [{ key: "b" }] },
        { key: "b", issue: 10, kind: "planning" },
      ],
    };
    const first = await registerSource(target, token, source);
    const a = first.keys.get("a") ?? "";
    const b = first.keys.get("b") ?? "";
    expect((await acceptPlanning(workspace, token, b)).json.reason).toBe("assignment_accepted");

    await editIssue(workspace.github, 10, { state: "closed" });
    await editIssue(workspace.github, 30, { body: "A sharper scope." });
    const { plan, inputPath } = await previewOnly(target, source, ["a"], { seed: false });
    expect(plan.json.data.counts).toMatchObject({ updated: 1, satisfiedBlockers: 0, refusals: 0 });

    await grant(workspace, token, plan.json.data.approval);
    const registered = await register(workspace, token, inputPath, plan.json.data.planRevision);
    expect(registered.exitCode).toBe(0);
    expect(dependenciesOf(workspace, a)).toEqual([b]);
  });
});
