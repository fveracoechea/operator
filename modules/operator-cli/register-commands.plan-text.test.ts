import { afterAll, describe, expect, test as bunTest } from "bun:test";
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
// Each test states its own bound, because a process-wide default would set the bound of every
// file in the bun test process (#179).
function test(name: string, run: () => Promise<void> | void, timeoutMs = 60_000) {
  bunTest(name, run, timeoutMs);
}

const fixtures = workspaces();

afterAll(async () => {
  await fixtures.removeAll();
});

async function owned(): Promise<{
  workspace: Workspace;
  token: string;
  target: FixtureTarget;
}> {
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

/** Seeds a read, previews it with an input that names only the given items, and reads its file. */
async function previewText(
  workspace: Workspace,
  read: FixtureSource,
  named: string[],
  edits: () => Promise<void> = async () => {},
) {
  const numbers = await seedSource(workspace.github, read);
  await edits();
  const input = sourceInput(
    { ...read, items: read.items.filter((item) => named.includes(item.key)) },
    numbers,
  );
  const inputPath = await writeInput(workspace.root, input);
  const plan = await planSource(
    {
      root: workspace.root,
      github: workspace.github,
      run: (args) => runJson(workspace, args),
    },
    inputPath,
  );
  return {
    text: await Bun.file(`${workspace.repo}/${plan.json.data.planPath}`).text(),
    data: plan.json.data,
    inputPath,
  };
}

/** Grants the approval one plan asks for and registers that plan revision. */
async function registerPlan(
  workspace: Workspace,
  token: string,
  preview: {
    data: { approval: object; planRevision: string };
    inputPath: string;
  },
) {
  await runJson(workspace, [
    "approval",
    "grant",
    "--request",
    requestId(),
    "--owner-token",
    token,
    "--input",
    await writeInput(workspace.root, {
      ...preview.data.approval,
      exactText: "Yes, record that plan.",
      grantedBy: "human",
    }),
  ]);
  return runJson(workspace, [
    "work",
    "register",
    "--request",
    requestId(),
    "--owner-token",
    token,
    "--input",
    preview.inputPath,
    "--plan-revision",
    preview.data.planRevision,
  ]);
}

/** Every recorded assignment and dependency, with no time, so a write is compared byte for byte. */
function recordedRows(workspace: Workspace) {
  const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`, {
    readonly: true,
  });
  try {
    return {
      sources: sqlite
        .query(
          "select id, kind, revision, tracker_location, order_index from work_sources order by id",
        )
        .all(),
      assignments: sqlite
        .query(
          "select id, source_id, source_key, source_revision, tracker_binding, title, kind, planning_type, order_index, approved_scope, scope_identity, acceptance_requirements, permissions, fixed_inputs, fixed_inputs_identity, state, revision, withdrawn_under from assignments order by id",
        )
        .all(),
      dependencies: sqlite
        .query("select assignment_id, depends_on_id from assignment_dependencies order by 1, 2")
        .all(),
    };
  } finally {
    sqlite.close();
  }
}

/**
 * The pinned text of one stored plan. The plan revision hashes its basis, so each byte counts.
 * The formatter may wrap the fixture file, so its value is written back the way the CLI writes.
 */
async function pinned(name: string): Promise<string> {
  const file = Bun.file(new URL(`./registration-plan-${name}.fixture.json`, import.meta.url));
  return `${JSON.stringify(await file.json(), null, 2)}\n`;
}

// The stored plan is what a person reads and approves, so its text must not move when its
// writer is restructured. Each test pins a plan that reaches many paths of the planner.
describe("work register --plan, the stored plan text", () => {
  test("pins a plan with a new, an updated, a closed, and a withdrawn item", async () => {
    const { workspace, token, target } = await owned();
    const other = await registerSource(target, token, {
      sourceKind: "specification",
      parent: 94,
      items: [{ key: "x", issue: 70, kind: "planning" }],
    });
    expect(other.keys.size).toBe(1);
    const first = await registerSource(target, token, {
      sourceKind: "specification",
      parent: 93,
      items: [
        { key: "a", issue: 30 },
        { key: "b", issue: 10, dependsOn: [{ key: "a" }] },
        { key: "c", issue: 20, kind: "planning" },
        { key: "w", issue: 40 },
      ],
    });
    const c = first.keys.get("c") ?? "";
    expect((await acceptPlanning(workspace, token, c)).json.reason).toBe("assignment_accepted");

    const preview = await previewText(
      workspace,
      {
        sourceKind: "specification",
        parent: 93,
        items: [
          { key: "a", issue: 30 },
          { key: "b", issue: 10, dependsOn: [{ key: "a" }] },
          { key: "c", issue: 20, kind: "planning", state: "closed" },
          { key: "e", issue: 60, state: "closed" },
          {
            key: "d",
            issue: 50,
            dependsOn: [{ key: "a" }, { key: "e" }, { key: "x", sourceId: issueKey(94) }],
          },
        ],
      },
      ["b", "d"],
      async () => {
        await editIssue(workspace.github, 10, { body: "A sharper scope." });
        await editIssue(workspace.github, 93, {
          body: "A changed destination.",
        });
      },
    );

    expect(preview.text).toBe(await pinned("changed"));

    // The write records exactly that plan, and its report and rows stay the same too.
    const registered = await registerPlan(workspace, token, preview);
    const written = `${JSON.stringify({ report: registered.json, rows: recordedRows(workspace) }, null, 2)}\n`;
    expect(written).toBe(await pinned("changed-write"));
  });

  test("pins a plan that refuses an item on each path", async () => {
    const { workspace, token, target } = await owned();
    const first = await registerSource(target, token, {
      sourceKind: "specification",
      parent: 93,
      items: [
        { key: "a", issue: 30 },
        { key: "b", issue: 10, dependsOn: [{ key: "w" }] },
        { key: "c", issue: 20 },
        { key: "w", issue: 40 },
      ],
    });
    expect((await claim(workspace, token, first.keys.get("a") ?? "")).exitCode).toBe(0);
    // An issue that no source registered, so a blocker on it is unregistered.
    await seedSource(workspace.github, {
      sourceKind: "specification",
      parent: 95,
      items: [{ key: "u", issue: 80 }],
    });

    const { text } = await previewText(
      workspace,
      {
        sourceKind: "specification",
        parent: 93,
        items: [
          { key: "a", issue: 30 },
          { key: "b", issue: 10, dependsOn: [{ key: "w" }] },
          { key: "c", issue: 20, state: "closed" },
          {
            key: "n",
            issue: 50,
            dependsOn: [{ key: "u", sourceId: issueKey(95) }],
          },
          { key: "m", issue: 51 },
          {
            key: "p",
            issue: 52,
            permissions: {
              writePaths: [],
              allowedCommands: [],
              network: false,
            },
          },
          { key: "o", issue: 53, repository: "someone/elsewhere" },
        ],
      },
      ["a", "n", "p", "o"],
      async () => {
        await editIssue(workspace.github, 30, {
          body: "A changed scope after the claim.",
        });
      },
    );

    expect(text).toBe(await pinned("refused"));
  });

  test("pins a plan of a new wayfinder source with its kind refusals", async () => {
    const { workspace } = await owned();
    const { text } = await previewText(
      workspace,
      {
        sourceKind: "wayfinder",
        parent: 93,
        items: [
          { key: "r", issue: 30, wayfinderType: "research" },
          {
            key: "t",
            issue: 31,
            wayfinderType: "task",
            dependsOn: [{ key: "r" }],
          },
          { key: "k", issue: 32, wayfinderType: "task", kind: "planning" },
          { key: "z", issue: 33 },
          {
            key: "f",
            issue: 34,
            wayfinderType: "task",
            fixedInputs: [
              {
                name: "brief",
                kind: "path",
                value: "docs/missing.md",
                contentIdentity: "0".repeat(64),
              },
            ],
          },
        ],
      },
      ["r", "t", "k", "z", "f"],
    );

    expect(text).toBe(await pinned("wayfinder"));
  });
});
