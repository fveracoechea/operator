import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { ContentIdentity } from "../content-identity/main.ts";

// Crew tests spawn several CLI processes against the same project fixture.
setDefaultTimeout(60_000);

const cliPath = new URL("../../cli.ts", import.meta.url).pathname;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function makeProject(files: Record<string, string> = {}): Promise<string> {
  const root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-crew-${crypto.randomUUID()}`;
  temporaryRoots.push(root);
  await Bun.$`mkdir -p ${root}`.quiet();
  for (const [path, content] of Object.entries(files)) {
    await Bun.write(`${root}/${path}`, content, { createPath: true });
  }
  return root;
}

async function runOperator(root: string, args: string[]) {
  const child = Bun.spawn(["bun", cliPath, ...args], {
    cwd: root,
    stderr: "pipe",
    stdout: "pipe",
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

function item(overrides: ItemOverrides) {
  const { key, title, kind, wayfinderType, dependsOn, writePaths, fixedInputs } = overrides;
  return {
    key,
    title: title ?? `Item ${key}`,
    ...(wayfinderType === undefined ? { kind: kind ?? "production" } : { wayfinderType }),
    approvedScope: `The approved scope of item ${key}.`,
    acceptanceRequirements: ["The quality gate passes."],
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
  revision?: string;
  // A test can send an item that the schema refuses, so an item can be any value.
  items: unknown[];
};

async function writeSource(root: string, overrides: SourceOverrides): Promise<string> {
  const body = {
    sourceKind: overrides.sourceKind ?? "specification",
    source: {
      id: overrides.id ?? "github:operator#15",
      revision: overrides.revision ?? "rev-1",
      tracker: "github",
    },
    items: overrides.items,
  };
  const path = `${root}/request-${crypto.randomUUID()}.json`;
  await Bun.write(path, JSON.stringify(body));
  return path;
}

async function overlaps(root: string, sourceId: string) {
  return runJson(root, ["work", "overlaps", "--source", sourceId]);
}

async function register(root: string, token: string, overrides: SourceOverrides) {
  const path = await writeSource(root, overrides);
  return runJson(root, [
    "work",
    "register",
    "--request",
    request(),
    "--owner-token",
    token,
    "--input",
    path,
  ]);
}

type Registration = { data: { registered: Array<{ sourceKey: string; assignmentId: string }> } };

function assignmentIdOf(registered: Registration, key: string): string {
  const found = registered.data.registered.find((one) => one.sourceKey === key);
  if (found === undefined) {
    throw new Error(`the registration reported no assignment for ${key}`);
  }

  return found.assignmentId;
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
) {
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
  ]);
}

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
    expect(wayfinder.json.data.registered[0]).toMatchObject({
      kind: "production",
      executable: true,
    });
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

    expect(
      registered.json.data.registered.map((one: { sourceKey: string; executable: boolean }) => [
        one.sourceKey,
        one.executable,
      ]),
    ).toEqual([
      ["research-1", false],
      ["grilling-1", false],
      ["task-1", true],
    ]);

    const frontier = await runJson(root, ["work", "frontier"]);
    expect(
      frontier.json.data.dispatchable.map((one: { sourceKey: string }) => one.sourceKey),
    ).toEqual(["task-1"]);
    expect(frontier.json.data.planning.map((one: { sourceKey: string }) => one.sourceKey)).toEqual([
      "research-1",
      "grilling-1",
    ]);

    const planningId = assignmentIdOf(registered.json, "research-1");
    const refused = await claim(root, token, planningId, 1);
    expect(refused.exitCode).toBe(2);
    expect(refused.json.reason).toBe("planning_only");
  });

  test("rejects a dependency cycle before anything is dispatched", async () => {
    const root = await makeProject();
    const token = await own(root);

    const result = await register(root, token, {
      items: [
        item({ key: "a", dependsOn: [{ key: "b" }] }),
        item({ key: "b", dependsOn: [{ key: "a" }] }),
      ],
    });

    expect(result.exitCode).toBe(2);
    expect(result.json.reason).toBe("dependency_cycle");

    const frontier = await runJson(root, ["work", "frontier"]);
    expect(frontier.json.data.dispatchable).toEqual([]);
    expect(frontier.json.data.blocked).toEqual([]);
  });

  test("names an existing assignment instead of registering it twice", async () => {
    const root = await makeProject();
    const token = await own(root);

    const first = await register(root, token, { items: [item({ key: "a" })] });
    const second = await register(root, token, {
      items: [item({ key: "a" }), item({ key: "b" })],
    });

    expect(
      second.json.data.existing.map((one: { assignmentId: string }) => one.assignmentId),
    ).toEqual([assignmentIdOf(first.json, "a")]);
    expect(second.json.data.registered.map((one: { sourceKey: string }) => one.sourceKey)).toEqual([
      "b",
    ]);
  });

  test("refuses a changed source revision so fixed inputs stay fixed", async () => {
    const root = await makeProject();
    const token = await own(root);
    await register(root, token, { items: [item({ key: "a" })] });

    const result = await register(root, token, { revision: "rev-2", items: [item({ key: "a" })] });

    expect(result.exitCode).toBe(4);
    expect(result.json.reason).toBe("source_revision_changed");
    expect(result.json.blockers[0]).toMatchObject({
      recordedRevision: "rev-1",
      requestedRevision: "rev-2",
    });
  });

  test("refuses a re-registration that states different dependencies", async () => {
    const root = await makeProject();
    const token = await own(root);
    await register(root, token, { items: [item({ key: "a" }), item({ key: "b" })] });

    const changed = await register(root, token, {
      items: [
        item({ key: "a", dependsOn: [{ key: "b" }] }),
        item({ key: "b", dependsOn: [{ key: "a" }] }),
      ],
    });

    expect(changed.exitCode).toBe(4);
    expect(changed.json.reason).toBe("dependencies_changed");

    const frontier = await runJson(root, ["work", "frontier"]);
    expect(
      frontier.json.data.dispatchable.map((one: { sourceKey: string }) => one.sourceKey),
    ).toEqual(["a", "b"]);
  });

  test("refuses a re-registration that states different fixed inputs", async () => {
    const root = await makeProject();
    const token = await own(root);
    const notes = { name: "notes", kind: "value", value: "the notes", contentIdentity: null };
    const brief = { name: "brief", kind: "value", value: "the brief", contentIdentity: null };
    const registered = await register(root, token, {
      items: [item({ key: "a", fixedInputs: [brief, notes] })],
    });

    const changed = await register(root, token, {
      items: [
        item({ key: "a", fixedInputs: [{ ...brief, value: "another brief" }, notes] }),
        item({ key: "b" }),
      ],
    });

    expect(changed.exitCode).toBe(4);
    expect(changed.json.reason).toBe("fixed_inputs_changed");
    // The refusal names only the input that differs and carries no input text, so it stays short.
    expect(changed.json.blockers).toEqual([
      {
        reason: "fixed_inputs_changed",
        sourceKey: "a",
        assignmentId: assignmentIdOf(registered.json, "a"),
        changed: ["brief"],
      },
    ]);

    // A refused registration records nothing, not even the new item beside the changed one.
    const frontier = await runJson(root, ["work", "frontier"]);
    expect(
      frontier.json.data.dispatchable.map((one: { sourceKey: string }) => one.sourceKey),
    ).toEqual(["a"]);
  });

  test("refuses a path fixed input whose file does not match its content identity", async () => {
    const root = await makeProject({ "docs/spec.md": "# Spec\n" });
    const token = await own(root);

    const changed = await register(root, token, {
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

    expect(changed.exitCode).toBe(2);
    expect(changed.json.reason).toBe("fixed_input_mismatch");
    expect(changed.json.blockers[0]).toMatchObject({
      sourceKey: "a",
      name: "spec",
      path: "docs/spec.md",
      statedIdentity: ContentIdentity.ofText("# Old spec\n"),
      foundIdentity: ContentIdentity.ofText("# Spec\n"),
    });

    const frontier = await runJson(root, ["work", "frontier"]);
    expect(frontier.json.data.dispatchable).toEqual([]);
  });

  test("refuses a path fixed input whose file is not in the checkout", async () => {
    const root = await makeProject();
    const token = await own(root);

    const missing = await register(root, token, {
      items: [
        item({
          key: "a",
          fixedInputs: [
            { name: "spec", kind: "path", value: "docs/spec.md", contentIdentity: "f".repeat(64) },
          ],
        }),
      ],
    });

    expect(missing.exitCode).toBe(2);
    expect(missing.json.reason).toBe("fixed_input_mismatch");
    expect(missing.json.blockers[0]).toMatchObject({ path: "docs/spec.md", foundIdentity: null });
  });

  test("refuses a path fixed input outside the checkout", async () => {
    const root = await makeProject();
    const token = await own(root);

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
      const outside = await register(root, token, {
        items: [
          item({
            key: "a",
            fixedInputs: [{ name: "spec", kind: "path", value, contentIdentity: "f".repeat(64) }],
          }),
        ],
      });

      expect(outside.exitCode).toBe(2);
      expect(outside.json.reason).toBe("invalid_work_input");
    }
  });

  test("refuses a path fixed input with no content identity", async () => {
    const root = await makeProject({ "docs/spec.md": "# Spec\n" });
    const token = await own(root);

    const unfixed = await register(root, token, {
      items: [
        item({
          key: "a",
          fixedInputs: [
            { name: "spec", kind: "path", value: "docs/spec.md", contentIdentity: null },
          ],
        }),
      ],
    });

    expect(unfixed.exitCode).toBe(2);
    expect(unfixed.json.reason).toBe("invalid_work_input");
    expect(JSON.stringify(unfixed.json)).toContain("a path input requires its content identity");
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

    // A later edit of the file does not refuse the item that is already registered.
    await Bun.write(`${root}/docs/spec.md`, "# Changed spec\n");
    const again = await register(root, token, {
      items: [item({ key: "a", fixedInputs: [spec] })],
    });
    expect(again.json.reason).toBe("work_registered");
  });

  test("registers a dependency that names another source", async () => {
    const root = await makeProject();
    const token = await own(root);
    await register(root, token, { id: "github:operator#15", items: [item({ key: "a" })] });

    const second = await register(root, token, {
      sourceKind: "ticket",
      id: "github:operator#19",
      items: [item({ key: "b", dependsOn: [{ sourceId: "github:operator#15", key: "a" }] })],
    });

    expect(second.json.reason).toBe("work_registered");

    const frontier = await runJson(root, ["work", "frontier"]);
    expect(
      frontier.json.data.dispatchable.map((one: { sourceKey: string }) => one.sourceKey),
    ).toEqual(["a"]);
    expect(frontier.json.data.blocked[0]).toMatchObject({
      sourceKey: "b",
      blockers: [{ reason: "dependency_pending" }],
    });
  });

  test("refuses a dependency on work that is not registered", async () => {
    const root = await makeProject();
    const token = await own(root);

    const result = await register(root, token, {
      items: [item({ key: "a", dependsOn: [{ key: "missing" }] })],
    });

    expect(result.exitCode).toBe(2);
    expect(result.json.reason).toBe("unknown_dependency");
  });

  test("treats a wayfinder prototype as planning work", async () => {
    const root = await makeProject();
    const token = await own(root);

    const registered = await register(root, token, {
      sourceKind: "wayfinder",
      id: "github:operator#1",
      items: [item({ key: "prototype-1", wayfinderType: "prototype" })],
    });

    expect(registered.json.data.registered[0]).toMatchObject({
      kind: "planning",
      executable: false,
    });
  });

  test("reads a registration request from standard input", async () => {
    const root = await makeProject();
    const token = await own(root);
    const body = JSON.stringify({
      sourceKind: "ticket",
      source: { id: "github:operator#19", revision: "rev-1", tracker: "github" },
      items: [item({ key: "19" })],
    });

    const child = Bun.spawn(
      [
        "bun",
        cliPath,
        "work",
        "register",
        "--request",
        request(),
        "--owner-token",
        token,
        "--input",
        "-",
        "--json",
      ],
      { cwd: root, stdin: new TextEncoder().encode(body), stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).reason).toBe("work_registered");
  });

  test("reports every invalid field of a registration request", async () => {
    const root = await makeProject();
    const token = await own(root);
    const path = `${root}/broken.json`;
    await Bun.write(
      path,
      JSON.stringify({
        sourceKind: "ticket",
        source: { id: "github:operator#19", revision: "rev-1", tracker: "gitlab" },
        items: [{ ...item({ key: "a" }), surprise: true }],
      }),
    );

    const result = await runJson(root, [
      "work",
      "register",
      "--request",
      request(),
      "--owner-token",
      token,
      "--input",
      path,
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.json.reason).toBe("invalid_work_input");
    expect(result.json.blockers.length).toBeGreaterThan(1);
  });

  test("refuses every write path that is not in its canonical form, in item order", async () => {
    const root = await makeProject();
    const token = await own(root);

    const result = await register(root, token, {
      items: [
        item({
          key: "a",
          writePaths: ["/etc/", "./modules/", "modules/../docs/", "modules//crew/", "modules/."],
        }),
        item({ key: "b", writePaths: ["modules\\crew/", "modules/*.ts", "docs/adr-?.md", ""] }),
        item({ key: "c", writePaths: [] }),
        item({ key: "d", kind: "planning", writePaths: [] }),
        { ...item({ key: "e", writePaths: [] }), title: 5 },
        {
          ...item({ key: "f" }),
          permissions: { writePaths: [], allowedCommands: [""], network: false },
        },
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
      "items.2.permissions.writePaths",
      "items.4.title",
      "items.4.permissions.writePaths",
      "items.5.permissions.allowedCommands.0",
      "items.5.permissions.writePaths",
    ]);
    expect(result.json.blockers[0].issue).toContain("absolute");

    const frontier = await runJson(root, ["work", "frontier"]);
    expect(frontier.json.data.dispatchable).toEqual([]);
  });

  test("refuses a malformed item or permission record and checks only what it can read", async () => {
    const root = await makeProject();
    const token = await own(root);
    const empty = { writePaths: [], allowedCommands: [], network: false };

    const result = await register(root, token, {
      items: [
        null,
        "an item",
        { ...item({ key: "c" }), permissions: { ...empty, writePaths: null } },
        { ...item({ key: "d" }), permissions: { ...empty, surprise: true } },
        { ...item({ key: "e", writePaths: [] }), kind: "bogus" },
      ],
    });

    expect(result.exitCode).toBe(2);
    expect(result.json.reason).toBe("invalid_work_input");
    expect(result.json.blockers.map((one: { issue: string }) => one.issue.split(":")[0])).toEqual([
      "items.0",
      "items.1",
      "items.2.permissions.writePaths",
      "items.3.permissions",
      "items.3.permissions.writePaths",
      "items.4.kind",
    ]);
  });

  test("refuses a malformed item of a wayfinder source", async () => {
    const root = await makeProject();
    const token = await own(root);

    const result = await register(root, token, {
      sourceKind: "wayfinder",
      id: "github:operator#1",
      items: [null],
    });

    expect(result.exitCode).toBe(2);
    expect(result.json.reason).toBe("invalid_work_input");
  });

  test("refuses a wayfinder task with no write path and keeps planning work without one", async () => {
    const root = await makeProject();
    const token = await own(root);

    const result = await register(root, token, {
      sourceKind: "wayfinder",
      id: "github:operator#1",
      items: [
        item({ key: "research-1", wayfinderType: "research", writePaths: [] }),
        item({ key: "task-1", wayfinderType: "task", writePaths: [] }),
      ],
    });

    expect(result.exitCode).toBe(2);
    expect(result.json.blockers.map((one: { issue: string }) => one.issue.split(":")[0])).toEqual([
      "items.1.permissions.writePaths",
    ]);
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

    const result = await overlaps(root, "github:operator#15");

    expect(result.json.reason).toBe("overlaps_reported");
    expect(result.json.data.overlaps).toEqual([
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

    expect((await overlaps(root, "github:operator#15")).json.data.overlaps).toEqual([]);
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

    expect((await overlaps(root, "github:operator#15")).json.data.overlaps).toEqual([
      { sourceKeys: ["a", "b"], paths: [["modules/", "modules/crew-state/main.ts"]] },
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
    const text = await runOperator(root, [
      "work",
      "register",
      "--request",
      request(),
      "--owner-token",
      token,
      "--input",
      await writeSource(root, { items }),
    ]);

    expect(registered.json.data.overlaps).toEqual({
      pairCount: 3,
      sourceKeys: ["a", "c", "d"],
      command: "operator work overlaps --source github:operator#15",
    });
    expect(text.stdout).toContain("3 pair(s) of items write overlapping paths: a, c, d.");
    expect(text.stdout).toContain("operator work overlaps --source github:operator#15");
    expect(text.stdout).not.toContain("docs/adr/");
  });

  test("counts an overlap with an item of the same source that is already registered", async () => {
    const root = await makeProject();
    const token = await own(root);
    await register(root, token, { items: [item({ key: "a", writePaths: ["docs/"] })] });

    const second = await register(root, token, {
      items: [
        item({ key: "a", writePaths: ["docs/"] }),
        item({ key: "b", writePaths: ["docs/adr/"] }),
      ],
    });
    const otherSource = await register(root, token, {
      sourceKind: "ticket",
      id: "github:operator#19",
      items: [item({ key: "c", writePaths: ["docs/"] })],
    });

    expect(second.json.data.overlaps).toMatchObject({ pairCount: 1, sourceKeys: ["a", "b"] });
    expect(otherSource.json.data.overlaps).toMatchObject({ pairCount: 0, sourceKeys: [] });
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
    await register(root, token, {
      items: [item({ key: "a", writePaths: ["docs/"] }), item({ key: "b" })],
    });
    await Bun.$`bun -e ${`
      const { Database } = require("bun:sqlite");
      const db = new Database(${JSON.stringify(`${root}/.operator/local/crew-state.sqlite`)});
      db.exec(\`update assignments set permissions = '{"writePaths":["./docs/old"],"allowedCommands":[],"network":false}' where source_key = 'b'\`);
      db.close();
    `}`.quiet();

    const result = await overlaps(root, "github:operator#15");

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
    const id = assignmentIdOf(registered.json, "a");

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
    const id = assignmentIdOf(registered.json, "a");
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
    const id = assignmentIdOf(registered.json, "a");
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
    const id = assignmentIdOf(registered.json, "a");

    const stale = await claim(root, token, id, 7);

    expect(stale.exitCode).toBe(4);
    expect(stale.json.reason).toBe("stale_revision");
    expect(stale.json.blockers[0]).toMatchObject({ recordedRevision: 1 });
  });

  test("returns the recorded result for a repeated request identity", async () => {
    const root = await makeProject();
    const token = await own(root);
    const registered = await register(root, token, { items: [item({ key: "a" })] });
    const id = assignmentIdOf(registered.json, "a");
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
    const first = assignmentIdOf(registered.json, "a");
    const second = assignmentIdOf(registered.json, "b");
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
      assignmentIdOf(registered.json, "a"),
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
      assignmentIdOf(registered.json, "a"),
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
      assignmentIdOf(registered.json, "b"),
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
    const research = assignmentIdOf(registered.json, "research-1");
    const task = assignmentIdOf(registered.json, "task-1");

    const blocked = await runJson(root, ["work", "frontier"]);
    expect(blocked.json.data.dispatchable).toEqual([]);

    const accepted = await accept(root, token, research, null, 1);
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
    const id = assignmentIdOf(registered.json, "a");
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
      assignmentIdOf(registered.json, "research-1"),
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
    const first = assignmentIdOf(registered.json, "a");
    const second = assignmentIdOf(registered.json, "b");

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

    expect(
      frontier.json.data.dispatchable.map((one: { sourceKey: string }) => one.sourceKey),
    ).toEqual(["r", "a", "b"]);
    expect(frontier.json.data.blocked.map((one: { sourceKey: string }) => one.sourceKey)).toEqual([
      "c",
    ]);
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
      sourceKey: "c",
      blockers: [{ reason: "review_capacity_reserved" }],
    });

    await claim(root, token, assignmentIdOf(registered.json, "a"), 1);
    await claim(root, token, assignmentIdOf(registered.json, "b"), 1);

    const full = await runJson(root, ["work", "frontier"]);
    expect(full.exitCode).toBe(3);
    expect(full.json.reason).toBe("frontier_blocked");
    expect(full.json.data.capacity.active).toMatchObject({ total: 2, production: 2, review: 0 });

    const refused = await claim(root, token, assignmentIdOf(registered.json, "c"), 1);
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

    await claim(root, token, assignmentIdOf(registered.json, "a"), 1);

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

    expect(
      frontier.json.data.dispatchable.map((one: { sourceKey: string }) => one.sourceKey),
    ).toEqual(["review-a"]);
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
  return frontier.json.data.dispatchable.map((one) => one.sourceKey);
}

function blockersOf(frontier: { json: { data: FrontierReading } }, key: string) {
  return frontier.json.data.blocked.find((one) => one.sourceKey === key)?.blockers ?? [];
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
  const command = "operator work overlaps --source github:operator#15";

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
            assignmentId: assignmentIdOf(registered.json, "a"),
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
    const holder = assignmentIdOf(registered.json, "a");
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

    const refused = await claim(root, token, assignmentIdOf(registered.json, "b"), 1);
    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("assignment_not_dispatchable");
    expect(refused.json.blockers).toEqual(expected);

    // The command that the blocker names lists the pair that withholds the work.
    const listed = await runJson(root, command.split(" ").slice(1));
    expect(listed.json.data.overlaps).toEqual([
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
    const first = assignmentIdOf(registered.json, "a");
    const second = assignmentIdOf(registered.json, "b");
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

    await claim(root, token, assignmentIdOf(registered.json, "r"), 1);
    const started = await runJson(root, ["work", "frontier"]);
    expect(offered(started)).toEqual(["s", "a"]);

    // Review work is never withheld either, also when started production work holds its paths.
    await claim(root, token, assignmentIdOf(registered.json, "a"), 1);
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

    await claim(root, token, assignmentIdOf(first.json, "a"), 1);
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
