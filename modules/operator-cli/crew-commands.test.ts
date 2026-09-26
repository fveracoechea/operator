import { afterEach, describe, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";

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
};

function item(overrides: ItemOverrides) {
  const { key, title, kind, wayfinderType, dependsOn } = overrides;
  return {
    key,
    title: title ?? `Item ${key}`,
    ...(wayfinderType === undefined ? { kind: kind ?? "production" } : { wayfinderType }),
    approvedScope: `The approved scope of item ${key}.`,
    acceptanceRequirements: ["The quality gate passes."],
    permissions: { writePaths: ["modules/"], allowedCommands: ["bun test"], network: false },
    fixedInputs: [{ name: "brief", kind: "value", value: `brief ${key}`, contentIdentity: null }],
    dependsOn: dependsOn ?? [],
  };
}

type SourceOverrides = {
  sourceKind?: "specification" | "ticket" | "wayfinder";
  id?: string;
  revision?: string;
  items: ReturnType<typeof item>[];
};

async function register(root: string, token: string, overrides: SourceOverrides) {
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
