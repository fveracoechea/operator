import { afterEach, expect, test } from "bun:test";
import { githubCalls, herdrCalls, runJson, runOperator, workspaces } from "./workspace-fixture.ts";

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
    "wake-plugin": { state: "passed" },
  });
  expect(result.json.data.dispatch).toEqual({ state: "blocked", gate: "readiness" });
  expect(
    result.json.data.readiness.unproven.some(
      (one: { name: string }) => one.name === "provider-compatibility",
    ),
  ).toBe(true);
  expect((await herdrCalls(workspace)).filter((call) => call.startsWith("agent "))).toEqual([]);
  expect(await githubCalls(workspace)).toEqual(["GET user"]);
});

test("healthcheck reports a missing, disabled, or foreign wake plugin with installation steps", async () => {
  const workspace = await fixtures.make();
  for (const [marker, detail] of [
    ["plugin-missing", "not installed"],
    ["plugin-disabled", "disabled"],
    ["plugin-mismatch", "expected"],
  ] as const) {
    await Bun.write(`${workspace.herdr}/${marker}`, "");
    const result = await runJson(workspace, ["healthcheck", "--claude"]);
    expect(result.json.blockers).toContainEqual(
      expect.objectContaining({
        check: "wake-plugin-connection",
        nextAction: expect.stringContaining("herdr plugin link"),
        detail: expect.stringContaining(detail),
      }),
    );
    await Bun.$`rm ${workspace.herdr}/${marker}`.quiet();
  }
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
  expect(result.json.data.dispatch.gate).toBe("readiness");
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

test("healthcheck rejects an approval flag and lists full probe approval separately", async () => {
  const workspace = await fixtures.make();
  const invalid = await runJson(workspace, ["healthcheck", "--claude", "--approved-probe", "abc"]);
  expect(invalid.exitCode).toBe(2);
  const human = await runOperator(workspace, ["healthcheck", "--claude"]);
  expect(human.stdout).toContain("The full compatibility probe needs separate approval");
  expect(human.stdout).toContain("Herdr wake plugin: passed");
});
