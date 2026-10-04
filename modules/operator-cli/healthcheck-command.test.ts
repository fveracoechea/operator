import { afterEach, expect, test as bunTest } from "bun:test";
import { githubCalls, herdrCalls, runJson, runOperator, workspaces } from "./workspace-fixture.ts";

// Healthcheck tests start CLI processes that query fake Herdr and GitHub under the CI gate.
// Each test states its own bound, because a process-wide default would set the bound of every
// file in the bun test process (#179).
function test(name: string, run: () => Promise<void> | void, timeoutMs = 60_000) {
  bunTest(name, run, timeoutMs);
}

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

test("healthcheck reads connections and names unproven capabilities without launching or writing", async () => {
  const workspace = await fixtures.make({
    config: { operator: { host: "claude-code", model: "sonnet" }, crew: { host: "claude-code" } },
    tools: { claude: 'echo "2.0.1 (Claude Code)"' },
    files: { ".gitignore": "/.operator/\n" },
  });

  const result = await runJson(workspace, ["healthcheck", "--claude"]);

  expect(result.exitCode).toBe(3);
  expect(result.json.reason).toBe("healthcheck_blocked");
  expect(result.json.data.connections).toMatchObject({
    herdr: { state: "passed" },
    github: { state: "passed" },
  });
  expect(result.json.data.wakePlugin.state).toBe("passed");
  expect(result.json.data.dispatch).toEqual({
    readinessRequired: false,
    gate: "assignment-and-launch-preconditions",
  });
  expect(
    result.json.data.readiness.unproven.some(
      (one: { name: string }) => one.name === "provider-compatibility",
    ),
  ).toBe(true);
  expect((await herdrCalls(workspace)).filter((call) => call.startsWith("agent "))).toEqual([]);
  expect(await githubCalls(workspace)).toEqual(["GET user"]);
});

test("healthcheck reports a missing, disabled, or foreign wake plugin as an optional advisory", async () => {
  const workspace = await fixtures.make();
  for (const [marker, detail] of [
    ["plugin-missing", "not installed"],
    ["plugin-disabled", "disabled"],
    ["plugin-mismatch", "expected"],
  ] as const) {
    await Bun.write(`${workspace.herdr}/${marker}`, "");
    const result = await runJson(workspace, ["healthcheck", "--claude"]);
    expect(result.json.data.advisories).toContainEqual(
      expect.objectContaining({
        check: "wake-plugin",
        nextAction: expect.stringContaining("herdr plugin link"),
        detail: expect.stringContaining(detail),
      }),
    );
    expect(result.json.data.connections.herdr.state).toBe("passed");
    expect(
      result.json.blockers.some((one: { check: string }) => one.check === "wake-plugin-connection"),
    ).toBe(false);
    await Bun.$`rm ${workspace.herdr}/${marker}`.quiet();
  }
});

test("healthcheck reads a plugin list with no plugins as not installed, and skips an entry it cannot read", async () => {
  const workspace = await fixtures.make();
  await Bun.write(`${workspace.herdr}/plugin-unlisted`, "");
  const unlisted = await runJson(workspace, ["healthcheck", "--claude"]);
  expect(unlisted.json.data.wakePlugin).toEqual({
    state: "failed",
    detail: "The Operator wake plugin is not installed.",
    nextAction:
      'Run `herdr plugin link "$(operator wake plugin-path)"` and `herdr plugin enable operator.wake`, then check again. Unlink an earlier copy first.',
  });

  await Bun.$`rm ${workspace.herdr}/plugin-unlisted`.quiet();
  await Bun.write(`${workspace.herdr}/plugin-odd-entry`, "");
  const odd = await runJson(workspace, ["healthcheck", "--claude"]);
  expect(odd.json.data.wakePlugin).toEqual({
    state: "passed",
    detail: "The enabled Operator wake plugin matches this CLI release.",
    nextAction: null,
  });
});

test("healthcheck reports authentication failure and still keeps the dispatch gate tied to readiness", async () => {
  const workspace = await fixtures.make();
  await Bun.write(
    `${workspace.github}/faults.json`,
    JSON.stringify({ viewer: { kind: "status:401", remaining: 1 } }),
  );

  const result = await runJson(workspace, ["healthcheck", "--claude"]);

  expect(result.json.data.connections.github.state).toBe("failed");
  expect(result.json.blockers).toContainEqual(
    expect.objectContaining({
      check: "github-connection",
      nextAction: expect.stringContaining("gh auth login"),
    }),
  );
  expect(result.json.data.dispatch.readinessRequired).toBe(false);
});

test("healthcheck checks fixture read access without writing to its issue", async () => {
  const workspace = await fixtures.make({
    config: { probe: { githubFixture: { repository: "someone/fixture", issue: 7 } } },
  });

  const result = await runJson(workspace, ["healthcheck", "--claude"]);

  expect(result.json.data.connections.github).toMatchObject({
    state: "failed",
    detail: expect.stringContaining("someone/fixture#7"),
    nextAction: expect.stringContaining("token permissions"),
  });
  expect(await githubCalls(workspace)).toEqual(["GET user", "GET repos/someone/fixture/issues/7"]);
});

// The connection detail is what the person reads, so its bytes are pinned. A 2xx fixture answer
// passes in any shape, and a refused read names the gh detail with no code.
const FIXTURE = { repository: "someone/fixture", issue: 7 };
const FIXTURE_ACTION =
  "Check the fixture repository, issue, and GitHub token permissions, then check again.";
const connectionCases: Array<{
  name: string;
  arrange: (github: string) => Promise<unknown>;
  fixture: typeof FIXTURE | null;
  github: { state: string; detail: string; nextAction: string | null };
}> = [
  {
    name: "a viewer with no login",
    arrange: (github) =>
      Bun.write(`${github}/state.json`, JSON.stringify(fakeState({ viewer: null }))),
    fixture: null,
    github: {
      state: "failed",
      detail: "GitHub returned no user login.",
      nextAction: "Run `gh auth login`, then check GitHub access again.",
    },
  },
  {
    name: "no fixture",
    arrange: async () => {},
    fixture: null,
    github: {
      state: "passed",
      detail:
        "GitHub authenticated as operator-bot. Fixture read and write access are not proven without a configured fixture.",
      nextAction: null,
    },
  },
  {
    name: "a fixture answer that the tracker cannot read",
    arrange: (github) =>
      Bun.write(
        `${github}/state.json`,
        JSON.stringify(fakeState({ issues: { 7: { title: "x" } } })),
      ),
    fixture: FIXTURE,
    github: {
      state: "passed",
      detail:
        "GitHub authenticated as operator-bot and read fixture someone/fixture#7. Write access remains unproven.",
      nextAction: null,
    },
  },
  {
    name: "a fixture that GitHub does not hold",
    arrange: async () => {},
    fixture: FIXTURE,
    github: {
      state: "failed",
      detail: "Cannot read fixture someone/fixture#7: Not Found",
      nextAction: FIXTURE_ACTION,
    },
  },
  {
    name: "a fixture read that GitHub refuses",
    arrange: (github) =>
      Bun.write(
        `${github}/faults.json`,
        JSON.stringify({ readIssue: { kind: "status:403", remaining: 1 } }),
      ),
    fixture: FIXTURE,
    github: {
      state: "failed",
      detail: "Cannot read fixture someone/fixture#7: the fake refused",
      nextAction: FIXTURE_ACTION,
    },
  },
];

function fakeState(change: Record<string, unknown>) {
  return {
    viewer: "operator-bot",
    nextCommentId: 1,
    issues: {},
    comments: {},
    events: {},
    subIssues: {},
    blockedBy: {},
    ...change,
  };
}

for (const one of connectionCases) {
  test(`healthcheck names the GitHub connection for ${one.name}`, async () => {
    const workspace = await fixtures.make(
      one.fixture === null ? {} : { config: { probe: { githubFixture: one.fixture } } },
    );
    await one.arrange(workspace.github);

    const result = await runJson(workspace, ["healthcheck", "--claude"]);

    expect(result.json.data.connections.github).toEqual(one.github);
  });
}

test("healthcheck rejects an approval flag and lists full probe approval separately", async () => {
  const workspace = await fixtures.make();
  const invalid = await runJson(workspace, ["healthcheck", "--claude", "--approved-probe", "abc"]);
  expect(invalid.exitCode).toBe(2);
  const human = await runOperator(workspace, ["healthcheck", "--claude"]);
  expect(human.stdout).toContain("The full compatibility probe needs separate approval");
  expect(human.stdout).toContain("Herdr wake plugin (optional): passed");
});
