import { afterEach, describe, expect, test as bunTest } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { ContentIdentity } from "../content-identity/main.ts";
import {
  type FixtureItem,
  type FixtureSource,
  type FixtureTarget,
  issueKey,
  planSource,
  registerSource,
  seedSource,
  sourceInput,
  writeInput,
} from "./source-fixture.ts";
import { githubFakeEnvironment } from "./workspace-fixture.ts";

// Crew tests spawn several CLI processes against the same project fixture.
// Each test states its own bound, because a process-wide default would set the bound of every
// file in the bun test process (#179).
function test(name: string, run: () => Promise<void> | void, timeoutMs = 60_000) {
  bunTest(name, run, timeoutMs);
}

const cliPath = new URL("../../cli.ts", import.meta.url).pathname;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

/** The GitHub fake each project reads its sources from, kept beside the project. */
const fakes = new Map<string, Record<string, string>>();

async function makeProject(files: Record<string, string> = {}): Promise<string> {
  const root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-crew-${crypto.randomUUID()}`;
  temporaryRoots.push(root, `${root}.fake`);
  await Bun.$`mkdir -p ${root}`.quiet();
  for (const [path, content] of Object.entries(files)) {
    await Bun.write(`${root}/${path}`, content, { createPath: true });
  }
  fakes.set(root, await githubFakeEnvironment(`${root}.fake`));
  return root;
}

async function runOperator(root: string, args: string[], stdin?: string) {
  const child = Bun.spawn(["bun", cliPath, ...args], {
    cwd: root,
    stderr: "pipe",
    stdout: "pipe",
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    env: { ...process.env, ...fakes.get(root) },
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

async function runJson(root: string, args: string[]) {
  const result = await runOperator(root, [...args, "--json"]);
  return { ...result, json: JSON.parse(result.stdout) };
}

function request(): string {
  return crypto.randomUUID();
}

async function own(root: string, label = "operator-session"): Promise<string> {
  const result = await runJson(root, [
    "crew",
    "own",
    "--request",
    request(),
    "--owner-label",
    label,
  ]);
  return result.json.data.ownerToken;
}

type ItemOverrides = {
  key: string;
  title?: string;
  // A review is started by a submission and never registered. A test of the frontier order
  // registers production work and records it as a review directly.
  kind?: "production" | "review" | "planning";
  wayfinderType?: "research" | "grilling" | "prototype" | "task";
  dependsOn?: Array<{ sourceId?: string; key: string }>;
  writePaths?: string[];
  fixedInputs?: Array<{
    name: string;
    kind: string;
    value: string;
    contentIdentity: string | null;
  }>;
};

type Item = FixtureItem & { review: boolean };

function item(overrides: ItemOverrides): Item {
  const { key, title, kind, wayfinderType, dependsOn, writePaths, fixedInputs } = overrides;
  return {
    key,
    title: title ?? `Item ${key}`,
    kind:
      wayfinderType === undefined ? (kind === "planning" ? "planning" : "production") : undefined,
    wayfinderType,
    review: kind === "review",
    permissions: {
      // Each item writes its own folder by default, so only a test that names a path overlaps.
      writePaths: writePaths ?? [`modules/${key}/`],
      allowedCommands: ["bun test"],
      network: false,
    },
    fixedInputs: fixedInputs ?? [
      { name: "brief", kind: "value", value: `brief ${key}`, contentIdentity: null },
    ],
    dependsOn: dependsOn ?? [],
  };
}

type SourceOverrides = {
  sourceKind?: "specification" | "ticket" | "wayfinder";
  id?: string;
  items: Item[];
};

/** The item name each issue key stands for, so an assertion reads the names a test gave. */
const names = new Map<string, string>();

function nameOf(sourceKey: string): string {
  return names.get(sourceKey) ?? sourceKey;
}

function namesOf(entries: Array<{ sourceKey: string }>): string[] {
  return entries.map((one) => nameOf(one.sourceKey));
}

function parentOf(overrides: SourceOverrides): number {
  return Number(/#(\d+)$/.exec(overrides.id ?? "github:operator#15")?.[1] ?? "15");
}

function sourceOf(overrides: SourceOverrides): FixtureSource {
  return {
    sourceKind: overrides.sourceKind ?? "specification",
    parent: parentOf(overrides),
    items: overrides.items,
  };
}

function targetOf(root: string): FixtureTarget {
  return { root, github: `${root}.fake/github`, run: (args) => runJson(root, args) };
}

async function overlaps(root: string, sourceId: string) {
  return runJson(root, ["work", "overlaps", "--source", sourceId]);
}

/** The id the CLI records for a source the test named by its old spelling. */
function sourceIdOf(id = "github:operator#15"): string {
  return issueKey(parentOf({ id, items: [] }));
}

async function register(root: string, token: string, overrides: SourceOverrides) {
  const source = sourceOf(overrides);
  const registered = await registerSource(targetOf(root), token, source);
  for (const [key, number] of registered.numbers) {
    names.set(issueKey(number), key);
  }
  const reviews = overrides.items.filter((one) => one.review);
  if (reviews.length > 0) {
    const sqlite = new Database(`${root}/.operator/local/crew-state.sqlite`);
    for (const one of reviews) {
      sqlite
        .query("update assignments set kind = 'review' where id = ?")
        .run(registered.keys.get(one.key) ?? "");
    }
    sqlite.close();
  }
  return registered;
}

/** Previews one source and reports the plan file, which holds every refusal in order. */
async function preview(root: string, overrides: SourceOverrides) {
  const source = sourceOf(overrides);
  const numbers = await seedSource(`${root}.fake/github`, source);
  for (const [key, number] of numbers) {
    names.set(issueKey(number), key);
  }
  const inputPath = await writeInput(root, sourceInput(source, numbers));
  const plan = await planSource(targetOf(root), inputPath);
  const file =
    plan.json.data?.planPath === undefined
      ? null
      : await Bun.file(`${root}/${plan.json.data.planPath}`).json();
  return { plan, file, inputPath, input: sourceInput(source, numbers) };
}

/** Previews an input the schema reads, as a test wrote it. */
async function previewRaw(root: string, input: unknown) {
  return planSource(targetOf(root), await writeInput(root, input));
}

function assignmentIdOf(registered: { keys: Map<string, string> }, key: string): string {
  const found = registered.keys.get(key);
  if (found === undefined) {
    throw new Error(`the registration reported no assignment for ${key}`);
  }

  return found;
}

async function claim(root: string, token: string, assignmentId: string, revision: number) {
  return runJson(root, [
    "work",
    "claim",
    "--request",
    request(),
    "--owner-token",
    token,
    "--assignment",
    assignmentId,
    "--revision",
    String(revision),
  ]);
}

async function accept(
  root: string,
  token: string,
  assignmentId: string,
  attemptId: string | null,
  revision: number,
  planningRecord?: unknown,
) {
  const recordPath = `${root}/record-${crypto.randomUUID()}.json`;
  if (planningRecord !== undefined) {
    await Bun.write(recordPath, JSON.stringify(planningRecord));
  }
  return runJson(root, [
    "work",
    "accept",
    "--request",
    request(),
    "--owner-token",
    token,
    "--assignment",
    assignmentId,
    ...(attemptId === null ? [] : ["--attempt", attemptId]),
    "--revision",
    String(revision),
    ...(planningRecord === undefined ? [] : ["--input", recordPath]),
  ]);
}

/** The least a planning acceptance records: one decision. */
const PLANNING_RECORD = {
  entries: [
    {
      question: "Which library parses the feed?",
      escalationTriggers: [],
      authority: "operator-decision",
      interpretation: {
        summary: "Use the standard parser.",
        directives: ["Parse the feed with the standard parser."],
        appliesTo: ["The feed reader."],
      },
    },
  ],
  artifacts: [],
};

describe("operator crew own", () => {
  test("creates crew state and reports one owner token", async () => {
    const root = await makeProject();

    const result = await runJson(root, [
      "crew",
      "own",
      "--request",
      request(),
      "--owner-label",
      "first-session",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.json.reason).toBe("ownership_acquired");
    expect(result.json.data.revision).toBe(1);
    expect(await Bun.file(`${root}/.operator/local/crew-state.sqlite`).exists()).toBe(true);
  });

  test("refuses a second owner without an explicit takeover", async () => {
    const root = await makeProject();
    await own(root, "first-session");

    const result = await runJson(root, [
      "crew",
      "own",
      "--request",
      request(),
      "--owner-label",
      "second-session",
    ]);

    expect(result.exitCode).toBe(4);
    expect(result.json.reason).toBe("ownership_held");
    expect(result.json.blockers[0]).toMatchObject({ ownerLabel: "first-session" });
  });

  test("a repeated ownership request returns the recorded token", async () => {
    const root = await makeProject();
    const requestId = request();
    const ownArguments = ["crew", "own", "--request", requestId, "--owner-label", "first-session"];

    const first = await runJson(root, ownArguments);
    const second = await runJson(root, ownArguments);

    expect(second.exitCode).toBe(0);
    expect(second.json.data.ownerToken).toBe(first.json.data.ownerToken);
    expect(second.json.data.repeated).toBe(true);
    expect(second.json.data.revision).toBe(1);
  });

  test("refuses a takeover that names no ownership revision", async () => {
    const root = await makeProject();
    await own(root, "first-session");

    const result = await runJson(root, [
      "crew",
      "own",
      "--request",
      request(),
      "--owner-label",
      "second-session",
      "--takeover",
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.json.reason).toBe("invalid_arguments");
  });

  test("refuses a takeover from an ownership revision the crew has moved past", async () => {
    const root = await makeProject();
    await own(root, "first-session");

    const result = await runJson(root, [
      "crew",
      "own",
      "--request",
      request(),
      "--owner-label",
      "second-session",
      "--takeover",
      "--ownership-revision",
      "7",
    ]);

    expect(result.exitCode).toBe(4);
    expect(result.json.reason).toBe("ownership_revision_stale");
    expect(result.json.blockers[0]).toMatchObject({ recordedRevision: 1 });
  });

  test("an explicit takeover invalidates the former token", async () => {
    const root = await makeProject();
    const first = await own(root, "first-session");
    const registered = await register(root, first, { items: [item({ key: "a" })] });
    expect(registered.json.reason).toBe("work_registered");

    const taken = await runJson(root, [
      "crew",
      "own",
      "--request",
      request(),
      "--owner-label",
      "second-session",
      "--takeover",
      "--ownership-revision",
      "1",
    ]);
    expect(taken.json.reason).toBe("ownership_acquired");
    expect(taken.json.data.revision).toBe(2);
    expect(taken.json.data.replaced).toBe("first-session");

    const stale = await register(root, first, {
      id: "github:operator#16",
      items: [item({ key: "b" })],
    });
    expect(stale.exitCode).toBe(4);
    expect(stale.json.reason).toBe("ownership_stale");
  });
});

describe("operator work register", () => {
  test("registers an approved specification, a ready ticket, and a wayfinder map", async () => {
    const root = await makeProject();
    const token = await own(root);

    const specification = await register(root, token, {
      sourceKind: "specification",
      id: "github:operator#15",
      items: [item({ key: "15-a" })],
    });
    const ticket = await register(root, token, {
      sourceKind: "ticket",
      id: "github:operator#19",
      items: [item({ key: "19" })],
    });
    const wayfinder = await register(root, token, {
      sourceKind: "wayfinder",
      id: "github:operator#1",
      items: [item({ key: "task-1", wayfinderType: "task" })],
    });

    expect(specification.json.reason).toBe("work_registered");
    expect(ticket.json.reason).toBe("work_registered");
    expect(wayfinder.json.reason).toBe("work_registered");
    expect(wayfinder.assignments[0]).toMatchObject({ kind: "production" });
  });

  test("keeps planning-only work out of dispatch", async () => {
    const root = await makeProject();
    const token = await own(root);

    const registered = await register(root, token, {
      sourceKind: "wayfinder",
      id: "github:operator#1",
      items: [
        item({ key: "research-1", wayfinderType: "research" }),
        item({ key: "grilling-1", wayfinderType: "grilling" }),
        item({ key: "task-1", wayfinderType: "task" }),
      ],
    });

    expect(registered.assignments.map((one) => [nameOf(one.sourceKey), one.kind])).toEqual([
      ["research-1", "planning"],
      ["grilling-1", "planning"],
      ["task-1", "production"],
    ]);

    const frontier = await runJson(root, ["work", "frontier"]);
    expect(namesOf(frontier.json.data.dispatchable)).toEqual(["task-1"]);
    expect(namesOf(frontier.json.data.planning)).toEqual(["research-1", "grilling-1"]);

    const planningId = assignmentIdOf(registered, "research-1");
    const refused = await claim(root, token, planningId, 1);
    expect(refused.exitCode).toBe(2);
    expect(refused.json.reason).toBe("planning_only");
  });

  test("refuses a path fixed input whose file does not match its content identity", async () => {
    const root = await makeProject({ "docs/spec.md": "# Spec\n" });
    await own(root);

    const { plan, file } = await preview(root, {
      items: [
        item({
          key: "a",
          fixedInputs: [
            {
              name: "spec",
              kind: "path",
              value: "docs/spec.md",
              contentIdentity: ContentIdentity.ofText("# Old spec\n"),
            },
          ],
        }),
      ],
    });

    expect(plan.exitCode).toBe(2);
    expect(plan.json.blockers).toEqual([{ reason: "fixed_input_mismatch", count: 1 }]);
    expect(file.refusals[0]).toMatchObject({
      key: issueKey(1501),
      name: "spec",
      path: "docs/spec.md",
      statedIdentity: ContentIdentity.ofText("# Old spec\n"),
      foundIdentity: ContentIdentity.ofText("# Spec\n"),
    });

    const frontier = await runJson(root, ["work", "frontier"]);
    expect(frontier.json.data.dispatchable).toEqual([]);
  });

  test("refuses a path fixed input outside the checkout", async () => {
    const root = await makeProject();
    await own(root);

    // Git reads one spelling of a path at the base commit, so every other spelling is refused.
    for (const value of [
      "/etc/hosts",
      "../outside.md",
      "docs/../../outside.md",
      "docs//spec.md",
      "docs/./spec.md",
      "./docs/spec.md",
      "docs/",
    ]) {
      const { plan } = await preview(root, {
        items: [
          item({
            key: "a",
            fixedInputs: [{ name: "spec", kind: "path", value, contentIdentity: "f".repeat(64) }],
          }),
        ],
      });

      expect(plan.exitCode).toBe(2);
      expect(plan.json.reason).toBe("invalid_work_input");
    }
  });

  test("refuses a path fixed input with no content identity", async () => {
    const root = await makeProject({ "docs/spec.md": "# Spec\n" });
    await own(root);

    const { plan } = await preview(root, {
      items: [
        item({
          key: "a",
          fixedInputs: [
            { name: "spec", kind: "path", value: "docs/spec.md", contentIdentity: null },
          ],
        }),
      ],
    });

    expect(plan.exitCode).toBe(2);
    expect(plan.json.reason).toBe("invalid_work_input");
    expect(JSON.stringify(plan.json)).toContain("a path input requires its content identity");
  });

  test("registers a path fixed input whose file matches its content identity", async () => {
    const root = await makeProject({ "docs/spec.md": "# Spec\n" });
    const token = await own(root);
    const spec = {
      name: "spec",
      kind: "path",
      value: "docs/spec.md",
      contentIdentity: ContentIdentity.ofText("# Spec\n"),
    };

    const registered = await register(root, token, {
      items: [item({ key: "a", fixedInputs: [spec] })],
    });
    expect(registered.json.reason).toBe("work_registered");
  });

  test("registers a dependency on planning work of another source", async () => {
    const root = await makeProject();
    const token = await own(root);
    await register(root, token, {
      id: "github:operator#15",
      items: [item({ key: "a", kind: "planning" })],
    });

    const second = await register(root, token, {
      sourceKind: "ticket",
      id: "github:operator#19",
      items: [item({ key: "b", dependsOn: [{ sourceId: "github:operator#15", key: "a" }] })],
    });

    expect(second.json.reason).toBe("work_registered");

    const frontier = await runJson(root, ["work", "frontier"]);
    expect(namesOf(frontier.json.data.planning)).toEqual(["a"]);
    expect(frontier.json.data.blocked[0]).toMatchObject({
      sourceKey: issueKey(19),
      blockers: [{ reason: "dependency_pending" }],
    });
  });

  test("treats a wayfinder prototype as planning work", async () => {
    const root = await makeProject();
    const token = await own(root);

    const registered = await register(root, token, {
      sourceKind: "wayfinder",
      id: "github:operator#1",
      items: [item({ key: "prototype-1", wayfinderType: "prototype" })],
    });

    expect(registered.assignments[0]).toMatchObject({ kind: "planning" });
  });

  test("reads a registration request from standard input", async () => {
    const root = await makeProject();
    const token = await own(root);
    const { plan, input } = await preview(root, {
      sourceKind: "ticket",
      id: "github:operator#19",
      items: [item({ key: "19" })],
    });
    const body = JSON.stringify(input);

    const previewed = await runOperator(
      root,
      ["work", "register", "--plan", "--input", "-", "--json"],
      body,
    );
    const registered = await runOperator(
      root,
      [
        "work",
        "register",
        "--request",
        request(),
        "--owner-token",
        token,
        "--input",
        "-",
        "--plan-revision",
        plan.json.data.planRevision,
        "--json",
      ],
      body,
    );

    expect(JSON.parse(previewed.stdout).data.planRevision).toBe(plan.json.data.planRevision);
    expect(registered.exitCode).toBe(0);
    expect(JSON.parse(registered.stdout).reason).toBe("work_registered");
  });

  test("reports every invalid field of a registration request", async () => {
    const root = await makeProject();
    await own(root);
    const { input } = await preview(root, { items: [item({ key: "a" })] });

    const result = await previewRaw(root, {
      ...input,
      source: "not an issue",
      items: [{ ...input.items[0], surprise: true }],
    });

    expect(result.exitCode).toBe(2);
    expect(result.json.reason).toBe("invalid_work_input");
    expect(result.json.blockers.length).toBeGreaterThan(1);
  });

  test("refuses every write path that is not in its canonical form, in item order", async () => {
    const root = await makeProject();
    await own(root);
    const { input } = await preview(root, {
      items: ["a", "b", "c", "d", "e"].map((key) => item({ key })),
    });
    const [a, b, c, d, e] = input.items;
    const permissions = (writePaths: string[], allowedCommands = ["bun test"]) => ({
      writePaths,
      allowedCommands,
      network: false,
    });

    const result = await previewRaw(root, {
      ...input,
      items: [
        {
          ...a,
          permissions: permissions([
            "/etc/",
            "./modules/",
            "modules/../docs/",
            "modules//crew/",
            "modules/.",
          ]),
        },
        {
          ...b,
          permissions: permissions(["modules\\crew/", "modules/*.ts", "docs/adr-?.md", ""]),
        },
        { ...c, kind: "planning", permissions: permissions([]) },
        { ...d, acceptanceRequirements: 5, permissions: permissions(["/etc/"]) },
        { ...e, permissions: permissions(["modules/"], [""]) },
      ],
    });

    expect(result.exitCode).toBe(2);
    expect(result.json.reason).toBe("invalid_work_input");
    expect(result.json.blockers.map((one: { issue: string }) => one.issue.split(":")[0])).toEqual([
      "items.0.permissions.writePaths.0",
      "items.0.permissions.writePaths.1",
      "items.0.permissions.writePaths.2",
      "items.0.permissions.writePaths.3",
      "items.0.permissions.writePaths.4",
      "items.1.permissions.writePaths.0",
      "items.1.permissions.writePaths.1",
      "items.1.permissions.writePaths.2",
      "items.1.permissions.writePaths.3",
      "items.3.acceptanceRequirements",
      "items.3.permissions.writePaths.0",
      "items.4.permissions.allowedCommands.0",
    ]);
    expect(result.json.blockers[0].issue).toContain("absolute");

    const frontier = await runJson(root, ["work", "frontier"]);
    expect(frontier.json.data.dispatchable).toEqual([]);
  });

  test("refuses a malformed item or permission record", async () => {
    const root = await makeProject();
    await own(root);
    const { input } = await preview(root, { items: ["a", "b", "c"].map((key) => item({ key })) });
    const [, , c] = input.items;
    const empty = { writePaths: [], allowedCommands: [], network: false };

    const result = await previewRaw(root, {
      ...input,
      items: [
        null,
        "an item",
        { ...c, permissions: { ...empty, writePaths: null } },
        { ...c, permissions: { ...empty, surprise: true } },
        { ...c, kind: "bogus" },
        { ...c, kind: "review" },
      ],
    });

    expect(result.exitCode).toBe(2);
    expect(result.json.reason).toBe("invalid_work_input");
    expect(result.json.blockers.map((one: { issue: string }) => one.issue.split(":")[0])).toEqual([
      "items.0",
      "items.1",
      "items.2.permissions.writePaths",
      "items.3.permissions",
      "items.4.kind",
      "items.5.kind",
    ]);
  });

  test("refuses a malformed item of a wayfinder source", async () => {
    const root = await makeProject();
    await own(root);

    const result = await previewRaw(root, {
      sourceKind: "wayfinder",
      source: issueKey(1),
      items: [null],
    });

    expect(result.exitCode).toBe(2);
    expect(result.json.reason).toBe("invalid_work_input");
  });

  test("refuses a wayfinder task with no write path and keeps planning work without one", async () => {
    const root = await makeProject();
    await own(root);

    const { plan, file } = await preview(root, {
      sourceKind: "wayfinder",
      id: "github:operator#1",
      items: [
        item({ key: "research-1", wayfinderType: "research", writePaths: [] }),
        item({ key: "task-1", wayfinderType: "task", writePaths: [] }),
      ],
    });

    expect(plan.exitCode).toBe(2);
    expect(file.refusals).toEqual([{ reason: "write_paths_required", key: issueKey(102) }]);
  });

  test("accepts a write path that names a file the repository does not hold yet", async () => {
    const root = await makeProject();
    const token = await own(root);

    const result = await register(root, token, {
      items: [item({ key: "a", writePaths: ["modules/crew-state/write-paths.ts", "docs/adr/"] })],
    });

    expect(result.json.reason).toBe("work_registered");
  });

  test("reports each pair of overlapping items that no dependency orders", async () => {
    const root = await makeProject();
    const token = await own(root);
    await register(root, token, {
      items: [
        item({ key: "a", writePaths: ["modules/crew", "modules/crew/"] }),
        item({ key: "b", writePaths: ["modules/crew-state/"] }),
        item({ key: "c", writePaths: ["modules/"] }),
        item({ key: "d", writePaths: ["docs/adr/0018.md", "modules/crew-state/main.ts"] }),
        item({ key: "e", writePaths: ["modules/crew-state/"], dependsOn: [{ key: "c" }] }),
        item({ key: "f", writePaths: ["modules/crew-state/main.ts"], dependsOn: [{ key: "e" }] }),
        item({ key: "g", kind: "planning", writePaths: ["modules/"] }),
        item({ key: "h", writePaths: ["Modules/"] }),
      ],
    });

    const result = await overlaps(root, sourceIdOf());

    expect(result.json.reason).toBe("overlaps_reported");
    expect(
      result.json.data.overlaps.map((one: { sourceKeys: string[]; paths: unknown }) => ({
        sourceKeys: one.sourceKeys.map(nameOf),
        paths: one.paths,
      })),
    ).toEqual([
      {
        sourceKeys: ["a", "c"],
        paths: [
          ["modules/crew", "modules/"],
          ["modules/crew/", "modules/"],
        ],
      },
      { sourceKeys: ["b", "c"], paths: [["modules/crew-state/", "modules/"]] },
      { sourceKeys: ["b", "d"], paths: [["modules/crew-state/", "modules/crew-state/main.ts"]] },
      { sourceKeys: ["b", "e"], paths: [["modules/crew-state/", "modules/crew-state/"]] },
      { sourceKeys: ["b", "f"], paths: [["modules/crew-state/", "modules/crew-state/main.ts"]] },
      { sourceKeys: ["c", "d"], paths: [["modules/", "modules/crew-state/main.ts"]] },
      { sourceKeys: ["d", "e"], paths: [["modules/crew-state/main.ts", "modules/crew-state/"]] },
      {
        sourceKeys: ["d", "f"],
        paths: [["modules/crew-state/main.ts", "modules/crew-state/main.ts"]],
      },
    ]);
  });

  test("modules/crew does not cover modules/crew-state/", async () => {
    const root = await makeProject();
    const token = await own(root);
    await register(root, token, {
      items: [
        item({ key: "a", writePaths: ["modules/crew"] }),
        item({ key: "b", writePaths: ["modules/crew-state/"] }),
      ],
    });

    expect((await overlaps(root, sourceIdOf())).json.data.overlaps).toEqual([]);
  });

  test("modules/ covers modules/crew-state/main.ts", async () => {
    const root = await makeProject();
    const token = await own(root);
    await register(root, token, {
      items: [
        item({ key: "a", writePaths: ["modules/"] }),
        item({ key: "b", writePaths: ["modules/crew-state/main.ts"] }),
      ],
    });

    expect((await overlaps(root, sourceIdOf())).json.data.overlaps).toEqual([
      {
        sourceKeys: [issueKey(1501), issueKey(1502)],
        paths: [["modules/", "modules/crew-state/main.ts"]],
      },
    ]);
  });

  test("gives only a summary of the overlaps and the command that lists them", async () => {
    const root = await makeProject();
    const token = await own(root);
    const items = [
      item({ key: "a", writePaths: ["docs/"] }),
      item({ key: "b", writePaths: ["skills/"] }),
      item({ key: "c", writePaths: ["docs/adr/"] }),
      item({ key: "d", writePaths: ["docs/adr/0018.md"] }),
    ];

    const registered = await register(root, token, { items });
    const otherSource = await register(root, token, {
      sourceKind: "ticket",
      id: "github:operator#19",
      items: [item({ key: "e", writePaths: ["docs/"] })],
    });
    const { plan, inputPath } = await preview(root, {
      id: "github:operator#20",
      items: [item({ key: "f", writePaths: ["docs/"] }), item({ key: "g", writePaths: ["docs/"] })],
    });
    const text = await runOperator(root, [
      "work",
      "register",
      "--request",
      request(),
      "--owner-token",
      token,
      "--input",
      inputPath,
      "--plan-revision",
      plan.json.data.planRevision,
    ]);

    expect(registered.json.data.overlaps).toEqual({
      pairCount: 3,
      sourceKeys: [issueKey(1501), issueKey(1503), issueKey(1504)],
      command: `operator work overlaps --source ${sourceIdOf()}`,
    });
    // An item of another source never counts, because only one source shares a base.
    expect(otherSource.json.data.overlaps).toMatchObject({ pairCount: 0, sourceKeys: [] });
    expect(text.stdout).toContain(
      `1 pair(s) of items write overlapping paths: ${issueKey(2001)}, ${issueKey(2002)}.`,
    );
    expect(text.stdout).toContain(`operator work overlaps --source ${issueKey(20)}`);
    expect(text.stdout).not.toContain("docs/");
  });

  test("refuses to list the overlaps of a source that is not registered", async () => {
    const root = await makeProject();
    await own(root);

    const result = await overlaps(root, "github:operator#404");

    expect(result.exitCode).toBe(2);
    expect(result.json.reason).toBe("unknown_source");
  });

  test("reads a write path that was stored before the grammar existed in its canonical form", async () => {
    const root = await makeProject();
    const token = await own(root);
    const registered = await register(root, token, {
      items: [item({ key: "a", writePaths: ["docs/"] }), item({ key: "b" })],
    });
    const sqlite = new Database(`${root}/.operator/local/crew-state.sqlite`);
    sqlite
      .query(
        `update assignments set permissions = '{"writePaths":["./docs/old"],"allowedCommands":[],"network":false}' where id = ?`,
      )
      .run(assignmentIdOf(registered, "b"));
    sqlite.close();

    const result = await overlaps(root, sourceIdOf());

    expect(result.json.reason).toBe("overlaps_reported");
    expect(
      result.json.data.overlaps.map((one: { sourceKeys: string[] }) => ({
        ...one,
        sourceKeys: one.sourceKeys.map(nameOf),
      })),
    ).toEqual([{ sourceKeys: ["a", "b"], paths: [["docs/", "docs/old"]] }]);
  });
});

describe("operator work claim", () => {
  test("gives one assignment to exactly one of two concurrent claims", async () => {
    const root = await makeProject();
    const token = await own(root);
    const registered = await register(root, token, { items: [item({ key: "a" })] });
    const id = assignmentIdOf(registered, "a");

    const [first, second] = await Promise.all([
      claim(root, token, id, 1),
      claim(root, token, id, 1),
    ]);

    const outcomes = [first.json.reason, second.json.reason].toSorted();
    expect(outcomes).toEqual(["assignment_claimed", "assignment_already_claimed"].toSorted());

    const winner = first.json.reason === "assignment_claimed" ? first : second;
    const loser = first.json.reason === "assignment_claimed" ? second : first;
    expect(loser.exitCode).toBe(4);
    expect(loser.json.blockers[0]).toMatchObject({
      assignmentId: id,
      attemptId: winner.json.data.attemptId,
    });
  });

  test("names the holding attempt before it reports the revision", async () => {
    const root = await makeProject();
    const token = await own(root);
    const registered = await register(root, token, {
      items: [item({ key: "a" }), item({ key: "b" })],
    });
    const id = assignmentIdOf(registered, "a");
    await claim(root, token, id, 1);

    const stale = await claim(root, token, id, 1);

    expect(stale.exitCode).toBe(4);
    expect(stale.json.reason).toBe("assignment_already_claimed");
  });

  // Production work reaches acceptance through its reviewed submission, which needs a launched
  // reviewer. These claim rules are the same for any executable kind, so they use review work
  // that no submission produced, which accepts straight from its attempt.
  test("refuses a stale revision on work that an accepted attempt released", async () => {
    const root = await makeProject();
    const token = await own(root);
    const registered = await register(root, token, {
      items: [item({ key: "a", kind: "review" })],
    });
    const id = assignmentIdOf(registered, "a");
    const claimed = await claim(root, token, id, 1);
    await accept(root, token, id, claimed.json.data.attemptId, claimed.json.data.revision);

    const stale = await claim(root, token, id, 1);

    expect(stale.exitCode).toBe(4);
    expect(stale.json.reason).toBe("assignment_already_accepted");
  });

  test("refuses a stale revision on an assignment nobody holds", async () => {
    const root = await makeProject();
    const token = await own(root);
    const registered = await register(root, token, { items: [item({ key: "a" })] });
    const id = assignmentIdOf(registered, "a");

    const stale = await claim(root, token, id, 7);

    expect(stale.exitCode).toBe(4);
    expect(stale.json.reason).toBe("stale_revision");
    expect(stale.json.blockers[0]).toMatchObject({ recordedRevision: 1 });
  });

  test("returns the recorded result for a repeated request identity", async () => {
    const root = await makeProject();
    const token = await own(root);
    const registered = await register(root, token, { items: [item({ key: "a" })] });
    const id = assignmentIdOf(registered, "a");
    const requestId = request();
    const claimArguments = [
      "work",
      "claim",
      "--request",
      requestId,
      "--owner-token",
      token,
      "--assignment",
      id,
      "--revision",
      "1",
    ];

    const first = await runJson(root, claimArguments);
    const second = await runJson(root, claimArguments);

    expect(first.json.reason).toBe("assignment_claimed");
    expect(second.json.reason).toBe("assignment_claimed");
    expect(second.json.data.attemptId).toBe(first.json.data.attemptId);
    expect(second.json.data.repeated).toBe(true);

    const frontier = await runJson(root, ["work", "frontier"]);
    expect(frontier.json.data.active.length).toBe(1);
  });

  test("checks a refused request again instead of replaying its refusal", async () => {
    const root = await makeProject({
      ".operator/config.json": `${JSON.stringify({ operator: {}, crew: { maxActiveAgents: 1 } })}\n`,
    });
    const token = await own(root);
    const registered = await register(root, token, {
      items: [item({ key: "a", kind: "review" }), item({ key: "b" })],
    });
    const first = assignmentIdOf(registered, "a");
    const second = assignmentIdOf(registered, "b");
    const claimSecond = [
      "work",
      "claim",
      "--request",
      request(),
      "--owner-token",
      token,
      "--assignment",
      second,
      "--revision",
      "1",
    ];

    const claimed = await claim(root, token, first, 1);
    const refused = await runJson(root, claimSecond);
    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("assignment_not_dispatchable");

    await accept(root, token, first, claimed.json.data.attemptId, claimed.json.data.revision);

    // A refused request left no record, so the same identity is checked against the new state.
    const retried = await runJson(root, claimSecond);
    expect(retried.json.reason).toBe("assignment_claimed");
    expect(retried.json.data.repeated).toBe(false);
  });

  test("re-checks a request identity whose first use recorded nothing", async () => {
    const root = await makeProject();
    const token = await own(root);
    const registered = await register(root, token, { items: [item({ key: "a" })] });
    const requestId = request();

    const missing = await runJson(root, [
      "work",
      "claim",
      "--request",
      requestId,
      "--owner-token",
      token,
      "--assignment",
      "0".repeat(32),
      "--revision",
      "1",
    ]);
    expect(missing.json.reason).toBe("unknown_assignment");

    // The refused request recorded nothing, so this identity carries no input to disagree with.
    const claimed = await runJson(root, [
      "work",
      "claim",
      "--request",
      requestId,
      "--owner-token",
      token,
      "--assignment",
      assignmentIdOf(registered, "a"),
      "--revision",
      "1",
    ]);
    expect(claimed.json.reason).toBe("assignment_claimed");
  });

  test("refuses a reused request identity that carries different input", async () => {
    const root = await makeProject();
    const token = await own(root);
    const registered = await register(root, token, {
      items: [item({ key: "a" }), item({ key: "b" })],
    });
    const requestId = request();

    await runJson(root, [
      "work",
      "claim",
      "--request",
      requestId,
      "--owner-token",
      token,
      "--assignment",
      assignmentIdOf(registered, "a"),
      "--revision",
      "1",
    ]);
    const changed = await runJson(root, [
      "work",
      "claim",
      "--request",
      requestId,
      "--owner-token",
      token,
      "--assignment",
      assignmentIdOf(registered, "b"),
      "--revision",
      "1",
    ]);

    expect(changed.exitCode).toBe(2);
    expect(changed.json.reason).toBe("request_input_changed");
  });
});

describe("operator work accept", () => {
  test("accepts planning work with no attempt and unblocks its dependent", async () => {
    const root = await makeProject();
    const token = await own(root);
    const registered = await register(root, token, {
      sourceKind: "wayfinder",
      id: "github:operator#1",
      items: [
        item({ key: "research-1", wayfinderType: "research" }),
        item({ key: "task-1", wayfinderType: "task", dependsOn: [{ key: "research-1" }] }),
      ],
    });
    const research = assignmentIdOf(registered, "research-1");
    const task = assignmentIdOf(registered, "task-1");

    const blocked = await runJson(root, ["work", "frontier"]);
    expect(blocked.json.data.dispatchable).toEqual([]);

    const accepted = await accept(root, token, research, null, 1, PLANNING_RECORD);
    expect(accepted.exitCode).toBe(0);
    expect(accepted.json.reason).toBe("assignment_accepted");
    expect(accepted.json.data.attemptId).toBe(null);

    const open = await runJson(root, ["work", "frontier"]);
    expect(
      open.json.data.dispatchable.map((one: { assignmentId: string }) => one.assignmentId),
    ).toEqual([task]);
  });

  test("refuses to accept executable work that names no attempt", async () => {
    const root = await makeProject();
    const token = await own(root);
    const registered = await register(root, token, { items: [item({ key: "a" })] });
    const id = assignmentIdOf(registered, "a");
    const claimed = await claim(root, token, id, 1);

    const result = await accept(root, token, id, null, claimed.json.data.revision);

    expect(result.exitCode).toBe(2);
    expect(result.json.reason).toBe("attempt_required");
  });

  test("refuses to accept planning work that names an attempt", async () => {
    const root = await makeProject();
    const token = await own(root);
    const registered = await register(root, token, {
      sourceKind: "wayfinder",
      id: "github:operator#1",
      items: [item({ key: "research-1", wayfinderType: "research" })],
    });

    const result = await accept(
      root,
      token,
      assignmentIdOf(registered, "research-1"),
      crypto.randomUUID(),
      1,
    );

    expect(result.exitCode).toBe(2);
    expect(result.json.reason).toBe("attempt_not_expected");
  });
});

describe("operator work frontier", () => {
  test("unblocks a dependent only from an accepted result", async () => {
    const root = await makeProject();
    const token = await own(root);
    const registered = await register(root, token, {
      items: [item({ key: "a", kind: "review" }), item({ key: "b", dependsOn: [{ key: "a" }] })],
    });
    const first = assignmentIdOf(registered, "a");
    const second = assignmentIdOf(registered, "b");

    const blocked = await runJson(root, ["work", "frontier"]);
    expect(
      blocked.json.data.dispatchable.map((one: { assignmentId: string }) => one.assignmentId),
    ).toEqual([first]);
    expect(blocked.json.data.blocked[0]).toMatchObject({
      assignmentId: second,
      blockers: [{ reason: "dependency_pending" }],
    });

    const claimed = await claim(root, token, first, 1);
    const stillBlocked = await runJson(root, ["work", "frontier"]);
    expect(stillBlocked.json.data.blocked[0].blockers[0].reason).toBe("dependency_pending");

    await accept(root, token, first, claimed.json.data.attemptId, claimed.json.data.revision);

    const open = await runJson(root, ["work", "frontier"]);
    expect(
      open.json.data.dispatchable.map((one: { assignmentId: string }) => one.assignmentId),
    ).toEqual([second]);
    expect(
      open.json.data.accepted.map((one: { assignmentId: string }) => one.assignmentId),
    ).toEqual([first]);
  });

  test("keeps the registered source order and puts review before production", async () => {
    const root = await makeProject();
    const token = await own(root);
    await register(root, token, {
      id: "github:operator#15",
      items: [item({ key: "a" }), item({ key: "b" })],
    });
    await register(root, token, {
      id: "github:operator#16",
      items: [item({ key: "c" }), item({ key: "r", kind: "review" })],
    });

    const frontier = await runJson(root, ["work", "frontier"]);

    expect(namesOf(frontier.json.data.dispatchable)).toEqual(["r", "a", "b"]);
    expect(namesOf(frontier.json.data.blocked)).toEqual(["c"]);
  });

  test("defaults to three crew agents and holds the last slot for review", async () => {
    const root = await makeProject();
    const token = await own(root);
    const registered = await register(root, token, {
      items: [item({ key: "a" }), item({ key: "b" }), item({ key: "c" })],
    });

    const empty = await runJson(root, ["work", "frontier"]);
    expect(empty.json.data.capacity).toMatchObject({
      limit: 3,
      limitSource: "operator-default",
      reviewReserve: 1,
      productionLimit: 2,
    });
    expect(empty.json.data.dispatchable.length).toBe(2);
    expect(empty.json.data.blocked[0]).toMatchObject({
      sourceKey: issueKey(1503),
      blockers: [{ reason: "review_capacity_reserved" }],
    });

    await claim(root, token, assignmentIdOf(registered, "a"), 1);
    await claim(root, token, assignmentIdOf(registered, "b"), 1);

    const full = await runJson(root, ["work", "frontier"]);
    expect(full.exitCode).toBe(3);
    expect(full.json.reason).toBe("frontier_blocked");
    expect(full.json.data.capacity.active).toMatchObject({ total: 2, production: 2, review: 0 });

    const refused = await claim(root, token, assignmentIdOf(registered, "c"), 1);
    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("assignment_not_dispatchable");
  });

  test("a one-agent crew runs one assignment at a time", async () => {
    const root = await makeProject({
      ".operator/config.json": `${JSON.stringify({ operator: {}, crew: { maxActiveAgents: 1 } })}\n`,
    });
    const token = await own(root);
    const registered = await register(root, token, {
      items: [item({ key: "a" }), item({ key: "b" })],
    });

    const first = await runJson(root, ["work", "frontier"]);
    expect(first.json.data.capacity).toMatchObject({
      limit: 1,
      limitSource: "project-configuration",
      reviewReserve: 0,
      productionLimit: 1,
    });
    expect(first.json.data.dispatchable.length).toBe(1);

    await claim(root, token, assignmentIdOf(registered, "a"), 1);

    const second = await runJson(root, ["work", "frontier"]);
    expect(second.json.data.dispatchable).toEqual([]);
    expect(second.json.data.blocked[0].blockers[0]).toMatchObject({
      reason: "crew_at_capacity",
      limit: 1,
    });
  });

  test("a queued review outranks new production in a one-agent crew", async () => {
    const root = await makeProject({
      ".operator/config.json": `${JSON.stringify({ operator: {}, crew: { maxActiveAgents: 1 } })}\n`,
    });
    const token = await own(root);
    await register(root, token, {
      items: [item({ key: "a" }), item({ key: "review-a", kind: "review" })],
    });

    const frontier = await runJson(root, ["work", "frontier"]);

    expect(namesOf(frontier.json.data.dispatchable)).toEqual(["review-a"]);
  });
});

type FrontierReading = {
  dispatchable: Array<{ sourceKey: string }>;
  blocked: Array<{
    sourceKey: string;
    blockers: Array<{ reason: string; [key: string]: unknown }>;
  }>;
};

function offered(frontier: { json: { data: FrontierReading } }): string[] {
  return namesOf(frontier.json.data.dispatchable);
}

function blockersOf(frontier: { json: { data: FrontierReading } }, key: string) {
  return named(
    frontier.json.data.blocked.find((one) => nameOf(one.sourceKey) === key)?.blockers ?? [],
  );
}

/** The blockers with each holder named by the key the test gave it. */
function named(blockers: Array<{ reason: string; [key: string]: unknown }>) {
  return blockers.map((one) =>
    Array.isArray(one.holders)
      ? {
          ...one,
          holders: one.holders.map((holder: { sourceKey: string }) => ({
            ...holder,
            sourceKey: nameOf(holder.sourceKey),
          })),
        }
      : one,
  );
}

/** Writes the write paths of one assignment as an earlier release could have stored them. */
function storeWritePaths(root: string, assignmentId: string, writePaths: string[]): void {
  const sqlite = new Database(`${root}/.operator/local/crew-state.sqlite`);
  sqlite.run(
    "update assignments set permissions = json_set(permissions, '$.writePaths', json(?)) where id = ?",
    [JSON.stringify(writePaths), assignmentId],
  );
  sqlite.close();
}

describe("the frontier holds the write paths of unaccepted work", () => {
  const command = `operator work overlaps --source ${sourceIdOf()}`;

  test("withholds a production assignment that overlaps work offered earlier in the reading", async () => {
    const root = await makeProject();
    const token = await own(root);
    const registered = await register(root, token, {
      items: [
        item({ key: "a", writePaths: ["modules/crew-state/"] }),
        item({ key: "b", writePaths: ["modules/crew-state/frontier.ts", "docs/b.md"] }),
        item({ key: "c", writePaths: ["docs/c.md"] }),
      ],
    });

    const frontier = await runJson(root, ["work", "frontier"]);

    // The withheld entry takes no slot, so the next entry in priority order is offered.
    expect(offered(frontier)).toEqual(["a", "c"]);
    expect(blockersOf(frontier, "b")).toEqual([
      {
        reason: "write_paths_overlap",
        holders: [
          {
            assignmentId: assignmentIdOf(registered, "a"),
            sourceKey: "a",
            hold: "offered",
            pathPairCount: 1,
          },
        ],
        command,
      },
    ]);
  });

  test("a started assignment holds its paths, and a claim refuses through the same frontier", async () => {
    const root = await makeProject();
    const token = await own(root);
    const registered = await register(root, token, {
      items: [
        item({ key: "a", writePaths: ["modules/crew-state/"] }),
        item({ key: "b", writePaths: ["modules/crew-state/frontier.ts"] }),
      ],
    });
    const holder = assignmentIdOf(registered, "a");
    await claim(root, token, holder, 1);

    const frontier = await runJson(root, ["work", "frontier"]);
    const expected = [
      {
        reason: "write_paths_overlap",
        holders: [{ assignmentId: holder, sourceKey: "a", hold: "started", pathPairCount: 1 }],
        command,
      },
    ];
    expect(offered(frontier)).toEqual([]);
    expect(blockersOf(frontier, "b")).toEqual(expected);

    const refused = await claim(root, token, assignmentIdOf(registered, "b"), 1);
    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("assignment_not_dispatchable");
    expect(named(refused.json.blockers)).toEqual(expected);

    // The command that the blocker names lists the pair that withholds the work.
    const listed = await runJson(root, command.split(" ").slice(1));
    expect(
      listed.json.data.overlaps.map((one: { sourceKeys: string[] }) => ({
        ...one,
        sourceKeys: one.sourceKeys.map(nameOf),
      })),
    ).toEqual([
      {
        sourceKeys: ["a", "b"],
        paths: [["modules/crew-state/", "modules/crew-state/frontier.ts"]],
      },
    ]);
  });

  test("reads a write path stored by an earlier release in its canonical form", async () => {
    const root = await makeProject();
    const token = await own(root);
    const registered = await register(root, token, {
      items: [
        item({ key: "a", writePaths: ["modules/crew-state/"] }),
        item({ key: "b", writePaths: ["modules/crew-state/frontier.ts"] }),
      ],
    });
    const holder = assignmentIdOf(registered, "a");
    await claim(root, token, holder, 1);
    // An earlier release stored write paths with no grammar.
    storeWritePaths(root, holder, ["./modules//crew-state/old/../"]);

    const frontier = await runJson(root, ["work", "frontier"]);

    expect(offered(frontier)).toEqual([]);
    expect(blockersOf(frontier, "b")).toEqual([
      {
        reason: "write_paths_overlap",
        holders: [{ assignmentId: holder, sourceKey: "a", hold: "started", pathPairCount: 1 }],
        command,
      },
    ]);
  });

  test("refuses a stored write path that has no canonical form, and names it", async () => {
    const root = await makeProject();
    const token = await own(root);
    const registered = await register(root, token, {
      items: [
        item({ key: "a", writePaths: ["modules/crew-state/"] }),
        item({ key: "b", writePaths: ["docs/b.md"] }),
      ],
    });
    storeWritePaths(root, assignmentIdOf(registered, "a"), ["modules/../../outside/"]);

    const refused = await runOperator(root, ["work", "frontier", "--json"]);

    expect(refused.exitCode).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain(
      'the stored write path "modules/../../outside/" leaves the repository root',
    );
  });

  test("lists every holder by assignment id with its number of overlapping pairs", async () => {
    const root = await makeProject();
    const token = await own(root);
    const registered = await register(root, token, {
      items: [
        item({ key: "b", writePaths: ["docs/b.md"] }),
        item({ key: "a", writePaths: ["modules/x/two.ts", "modules/x/one.ts"] }),
        item({ key: "c", writePaths: ["modules/x/", "docs/", "skills/"] }),
      ],
    });
    const first = assignmentIdOf(registered, "a");
    const second = assignmentIdOf(registered, "b");
    // The started holder is found before the holder this reading offers, so only the sort puts
    // the smaller assignment id first.
    expect(first < second).toBe(true);
    await claim(root, token, second, 1);

    const frontier = await runJson(root, ["work", "frontier"]);

    expect(offered(frontier)).toEqual(["a"]);
    expect(blockersOf(frontier, "c")).toEqual([
      {
        reason: "write_paths_overlap",
        holders: [
          { assignmentId: first, sourceKey: "a", hold: "offered", pathPairCount: 2 },
          { assignmentId: second, sourceKey: "b", hold: "started", pathPairCount: 1 },
        ],
        command,
      },
    ]);
  });

  test("checks the overlap after the dependencies and before the crew capacity", async () => {
    const root = await makeProject({
      ".operator/config.json": `${JSON.stringify({ operator: {}, crew: { maxActiveAgents: 1 } })}\n`,
    });
    const token = await own(root);
    await register(root, token, {
      items: [
        item({ key: "a", writePaths: ["docs/"] }),
        item({ key: "b", writePaths: ["docs/b.md"] }),
        item({ key: "c", writePaths: ["docs/c.md"], dependsOn: [{ key: "b" }] }),
      ],
    });

    const frontier = await runJson(root, ["work", "frontier"]);

    expect(offered(frontier)).toEqual(["a"]);
    expect(blockersOf(frontier, "b").map((one) => one.reason)).toEqual(["write_paths_overlap"]);
    expect(blockersOf(frontier, "c").map((one) => one.reason)).toEqual(["dependency_pending"]);
  });

  test("an assignment that has not started holds nothing", async () => {
    const root = await makeProject();
    const token = await own(root);
    await register(root, token, {
      items: [
        item({ key: "gate", kind: "planning", writePaths: [] }),
        item({ key: "a", writePaths: ["docs/"], dependsOn: [{ key: "gate" }] }),
        item({ key: "b", writePaths: ["docs/b.md"] }),
      ],
    });

    const frontier = await runJson(root, ["work", "frontier"]);

    // The earlier entry waits on its dependency, so it never stands in front of a ready one.
    expect(offered(frontier)).toEqual(["b"]);
    expect(blockersOf(frontier, "a").map((one) => one.reason)).toEqual(["dependency_pending"]);
  });

  test("review and planning work hold no write paths, started or offered", async () => {
    const root = await makeProject();
    const token = await own(root);
    const registered = await register(root, token, {
      items: [
        item({ key: "r", kind: "review", writePaths: ["docs/"] }),
        item({ key: "s", kind: "review", writePaths: ["docs/"] }),
        item({ key: "p", kind: "planning", writePaths: ["docs/"] }),
        item({ key: "a", writePaths: ["docs/a.md"] }),
      ],
    });

    // The review comes first in priority order, so an offered review would hold the paths.
    const unstarted = await runJson(root, ["work", "frontier"]);
    expect(offered(unstarted)).toEqual(["r", "s", "a"]);

    await claim(root, token, assignmentIdOf(registered, "r"), 1);
    const started = await runJson(root, ["work", "frontier"]);
    expect(offered(started)).toEqual(["s", "a"]);

    // Review work is never withheld either, also when started production work holds its paths.
    await claim(root, token, assignmentIdOf(registered, "a"), 1);
    const held = await runJson(root, ["work", "frontier"]);
    expect(offered(held)).toEqual(["s"]);
  });

  test("holds paths only inside one source", async () => {
    const root = await makeProject();
    const token = await own(root);
    const first = await register(root, token, {
      id: "github:operator#15",
      items: [item({ key: "a", writePaths: ["docs/"] })],
    });
    await register(root, token, {
      id: "github:operator#16",
      items: [item({ key: "b", writePaths: ["docs/"] })],
    });

    // Both are offered in one reading, and a started holder of one source holds nothing in the other.
    const unstarted = await runJson(root, ["work", "frontier"]);
    expect(offered(unstarted)).toEqual(["a", "b"]);

    await claim(root, token, assignmentIdOf(first, "a"), 1);
    const started = await runJson(root, ["work", "frontier"]);
    expect(offered(started)).toEqual(["b"]);
  });

  test("holds paths that the repository does not hold", async () => {
    // The project is no repository and holds none of the paths, and the hold still applies.
    const root = await makeProject();
    const token = await own(root);
    await register(root, token, {
      items: [
        item({ key: "a", writePaths: ["not/there/"] }),
        item({ key: "b", writePaths: ["not/there/yet.ts"] }),
      ],
    });

    const frontier = await runJson(root, ["work", "frontier"]);

    expect(await Bun.file(`${root}/not/there/yet.ts`).exists()).toBe(false);
    expect(offered(frontier)).toEqual(["a"]);
    expect(blockersOf(frontier, "b").map((one) => one.reason)).toEqual(["write_paths_overlap"]);
  });
});

/** Reads the effective write paths of one assignment, and the grant request for asked paths. */
async function writePaths(root: string, assignmentId: string, paths?: unknown) {
  const input = paths === undefined ? [] : ["--input", await writeJson(root, { paths })];
  return runJson(root, ["work", "write-paths", "--assignment", assignmentId, ...input]);
}

async function writeJson(root: string, value: unknown): Promise<string> {
  const path = `${root}/input-${crypto.randomUUID()}.json`;
  await Bun.write(path, JSON.stringify(value));
  return path;
}

/** Records the person's grant of more write paths, from the exact request the CLI printed. */
async function grant(
  root: string,
  token: string,
  approval: { action: string; targets: string[]; scope: string; requestRevision: string },
) {
  return runJson(root, [
    "approval",
    "grant",
    "--request",
    request(),
    "--owner-token",
    token,
    "--input",
    await writeJson(root, {
      ...approval,
      exactText: "Yes, it may write that.",
      grantedBy: "human",
    }),
  ]);
}

describe("a person grants more write paths to an assignment", () => {
  const command = `operator work overlaps --source ${sourceIdOf()}`;

  test("the frontier hold reads the effective write paths of started work", async () => {
    const root = await makeProject();
    const token = await own(root);
    const registered = await register(root, token, {
      items: [
        item({ key: "a", writePaths: ["modules/a/"] }),
        item({ key: "b", writePaths: ["modules/b/"] }),
      ],
    });
    const holder = assignmentIdOf(registered, "a");
    await claim(root, token, holder, 1);
    expect(offered(await runJson(root, ["work", "frontier"]))).toEqual(["b"]);

    const asked = await writePaths(root, holder, ["modules/b/shared.ts"]);
    expect(asked.json.data.grant.overlaps).toEqual([]);
    const granted = await grant(root, token, asked.json.data.grant.approval);
    expect(granted.json.reason).toBe("approval_granted");

    const frontier = await runJson(root, ["work", "frontier"]);
    expect(offered(frontier)).toEqual([]);
    expect(blockersOf(frontier, "b")).toEqual([
      {
        reason: "write_paths_overlap",
        holders: [{ assignmentId: holder, sourceKey: "a", hold: "started", pathPairCount: 1 }],
        command,
      },
    ]);

    // The blocker points to the command that lists the pair that the grant caused.
    const listed = await runJson(root, ["work", "overlaps", "--source", sourceIdOf()]);
    expect(listed.json.data.overlaps).toEqual([
      {
        sourceKeys: [issueKey(1501), issueKey(1502)],
        paths: [["modules/b/shared.ts", "modules/b/"]],
      },
    ]);

    const shown = await writePaths(root, holder);
    expect(shown.json.data).toMatchObject({
      registered: ["modules/a/"],
      effective: ["modules/a/", "modules/b/shared.ts"],
      grant: null,
    });
  });

  test("the request names each started assignment the grant overlaps, and stops neither", async () => {
    const root = await makeProject();
    const token = await own(root);
    const registered = await register(root, token, {
      items: [
        item({ key: "a", writePaths: ["modules/a/"] }),
        item({ key: "b", writePaths: ["modules/b/", "docs/b.md"] }),
        item({ key: "c", writePaths: ["docs/c.md"] }),
        item({ key: "d", writePaths: ["skills/d.md"] }),
      ],
    });
    const asker = assignmentIdOf(registered, "a");
    const started = assignmentIdOf(registered, "b");
    for (const key of ["a", "b"]) {
      await claim(root, token, assignmentIdOf(registered, key), 1);
    }

    // `c` overlaps the grant too, but it has not started, so the frontier holds it instead.
    const asked = await writePaths(root, asker, ["modules/b/x.ts", "docs/"]);

    expect(asked.exitCode).toBe(0);
    expect(asked.json.reason).toBe("write_paths_reported");
    expect(asked.json.data.grant).toEqual({
      command,
      approval: {
        action: "write-paths-grant",
        targets: ["modules/b/x.ts", "docs/"],
        scope: asker,
        requestRevision: ContentIdentity.of({ writePaths: ["modules/a/"] }),
      },
      overlaps: [{ assignmentId: started, sourceKey: issueKey(1502), pathPairCount: 2 }],
    });
    expect(asked.stdout).not.toContain("--json");

    const text = await runOperator(root, [
      "work",
      "write-paths",
      "--assignment",
      asker,
      "--input",
      await writeJson(root, { paths: ["modules/b/x.ts", "docs/"] }),
    ]);
    expect(text.stdout).toContain("Only the person grants more write paths.");
    expect(text.stdout).toContain(`${issueKey(1502)} (${started}): 2 pair(s) of paths`);
    // The Operator reads this report, so it gives the count and never the path pairs.
    expect(text.stdout).not.toContain("docs/b.md");
    expect(text.stdout).toContain(`After the grant, list each pair with: ${command}`);

    await grant(root, token, asked.json.data.grant.approval);

    // Started work keeps its base, so the grant changes only what the frontier offers next.
    const frontier = await runJson(root, ["work", "frontier"]);
    expect(namesOf(frontier.json.data.active)).toEqual(["a", "b"]);
    expect(blockersOf(frontier, "c").map((one) => one.reason)).toEqual(["write_paths_overlap"]);
    expect(blockersOf(frontier, "d").map((one) => one.reason)).toEqual([
      "review_capacity_reserved",
    ]);
  });

  test("refuses a grant target that is not canonical", async () => {
    const root = await makeProject();
    const token = await own(root);
    const registered = await register(root, token, { items: [item({ key: "a" })] });
    const assignmentId = assignmentIdOf(registered, "a");

    const asked = await writePaths(root, assignmentId, ["./docs/", "notes/*.md"]);
    expect(asked.exitCode).toBe(2);
    expect(asked.json.reason).toBe("invalid_write_paths_input");
    expect(asked.json.blockers).toHaveLength(2);

    const refused = await grant(root, token, {
      action: "write-paths-grant",
      targets: ["docs/ok.md", "/etc/hosts", "docs\\b.md"],
      scope: assignmentId,
      requestRevision: ContentIdentity.of({ writePaths: ["modules/a/"] }),
    });
    expect(refused.exitCode).toBe(2);
    expect(refused.json.reason).toBe("invalid_approval_input");
    expect(refused.json.blockers.map((one: { issue: string }) => one.issue)).toEqual([
      expect.stringContaining("targets.1"),
      expect.stringContaining("targets.2"),
    ]);
    // An Operator decision is no grant, because a write path is a security permission.
    const decided = await runJson(root, [
      "approval",
      "grant",
      "--request",
      request(),
      "--owner-token",
      token,
      "--input",
      await writeJson(root, {
        action: "write-paths-grant",
        targets: ["docs/"],
        scope: assignmentId,
        requestRevision: ContentIdentity.of({ writePaths: ["modules/a/"] }),
        exactText: "The Operator decided that docs/ is fine.",
        grantedBy: "operator-decision",
      }),
    ]);
    expect(decided.json.reason).toBe("invalid_approval_input");
    expect((await writePaths(root, assignmentId)).json.data.effective).toEqual(["modules/a/"]);
  });

  test("only production work has write paths to widen", async () => {
    const root = await makeProject();
    const token = await own(root);
    const registered = await register(root, token, {
      items: [item({ key: "r", kind: "review", writePaths: ["docs/"] })],
    });

    const refused = await writePaths(root, assignmentIdOf(registered, "r"), ["notes/"]);

    expect(refused.json.reason).toBe("not_production_work");
    expect((await writePaths(root, "no-such-assignment")).json.reason).toBe("unknown_assignment");
  });
});

describe("commands that own no crew state", () => {
  test("refuse a crew flag they have no use for", async () => {
    const root = await makeProject();

    const installed = await runJson(root, ["install", "--claude", "--request", request()]);
    const planned = await runJson(root, ["setup", "plan", "--claude", "--owner-label", "session"]);

    expect(installed.exitCode).toBe(2);
    expect(installed.json.reason).toBe("invalid_arguments");
    expect(planned.exitCode).toBe(2);
    expect(planned.json.reason).toBe("invalid_arguments");
  });
});

describe("crew state that cannot serve a request", () => {
  test("blocks dispatch when no crew state exists", async () => {
    const root = await makeProject();

    const frontier = await runJson(root, ["work", "frontier"]);

    expect(frontier.exitCode).toBe(3);
    expect(frontier.json.reason).toBe("state_missing");
    expect(await Bun.file(`${root}/.operator/local/crew-state.sqlite`).exists()).toBe(false);
  });

  test("blocks dispatch on damaged state instead of replacing it", async () => {
    const root = await makeProject();
    await own(root);
    const path = `${root}/.operator/local/crew-state.sqlite`;
    await Bun.write(path, "this file is not a database");

    const frontier = await runJson(root, ["work", "frontier"]);

    expect(frontier.exitCode).toBe(4);
    expect(frontier.json.reason).toBe("unreadable_state");
    expect(await Bun.file(path).text()).toBe("this file is not a database");
  });

  test("blocks dispatch on state a newer Operator release wrote", async () => {
    const root = await makeProject();
    await own(root);
    await Bun.$`bun -e ${`
      const { Database } = require("bun:sqlite");
      const db = new Database(${JSON.stringify(`${root}/.operator/local/crew-state.sqlite`)});
      db.exec("update state_meta set state_version = 99 where id = 1");
      db.close();
    `}`.quiet();

    const frontier = await runJson(root, ["work", "frontier"]);

    expect(frontier.exitCode).toBe(1);
    expect(frontier.json.reason).toBe("state_version_unsupported");
    expect(frontier.json.blockers[0]).toMatchObject({ found: 99 });
  });
});
