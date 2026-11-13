import { afterEach, expect, test } from "bun:test";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import { z } from "zod";
import { Environment } from "../environment/main.ts";
import { fixtureCommand } from "./command-fixture.ts";
import { workerDevice } from "./worker-fixture.ts";

let device: Awaited<ReturnType<typeof workerDevice>>;
afterEach(async () => {
  await rm(device.root, { recursive: true, force: true });
});

test("each listed workflow syntax refusal names help without writing or launching", async () => {
  device = await workerDevice();
  const database = Bun.file(`${device.root}/state/operator/operator.sqlite`);
  const before = await database.arrayBuffer();
  const calls = await device.herdrCalls();
  for (const args of [
    ["dispatch"],
    ["source", "register"],
    ["next", "--unknown"],
    ["report", "submit"],
    ["question", "ask"],
    ["message", "read"],
    ["obligation", "add"],
    ["cleanup"],
    ["internal-review", "skip"],
  ]) {
    const result = await device.run(args);
    expect(result.code).toBe(2);
    expect(result.output).toMatchObject({
      reason: "invalid_arguments",
      outcome: "invalid",
      next: { command: "operator --help", why: "Read the supported command syntax." },
    });
    expect(result.output).not.toHaveProperty("state");
    expect(result.stderr.trim().split("\n")).toEqual([
      "operator: invalid_arguments: The command arguments are not supported.",
      "next: operator --help",
    ]);
  }
  expect(await database.arrayBuffer()).toEqual(before);
  expect(await device.herdrCalls()).toEqual(calls);
  const help = await device.exec([...fixtureCommand().argv, "--help"], device.main);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("operator dispatch --source id --assignment key");
  expect(help.stdout.split("\n").length).toBeGreaterThan(3);
});

test("workflow startup refusal reports missing state without creating it or checking an assignment", async () => {
  device = await workerDevice();
  const isolated = `${device.root}/unregistered`;
  const result = await device.exec(
    [
      ...fixtureCommand().argv,
      "dispatch",
      "--source",
      "unknown",
      "--assignment",
      "unchecked",
      "--json",
    ],
    device.main,
    Environment.child({
      HOME: isolated,
      XDG_CONFIG_HOME: `${isolated}/config`,
      XDG_STATE_HOME: `${isolated}/state`,
    }),
  );
  expect(result.code).toBe(3);
  const output: unknown = JSON.parse(result.stdout);
  expect(output).toMatchObject({
    operation: "startup",
    reason: "state_missing",
    next: {
      command: "operator project register",
      why: "Register a project explicitly to initialize device state.",
    },
  });
  expect(output).not.toHaveProperty("state");
  expect(result.stderr.trim().split("\n").length).toBeLessThanOrEqual(3);
  expect(await Bun.file(`${isolated}/state/operator/operator.sqlite`).exists()).toBe(false);
});

test("linked checkout recovery quotes the controlling repository command and checks no workflow state", async () => {
  device = await workerDevice();
  const controller = await device.checkout("owner's $(touch injected)", "example/quoted");
  const linked = `${device.root}/linked`;
  expect(
    (await device.exec(["git", "worktree", "add", "-b", "task/linked", linked], controller)).code,
  ).toBe(0);
  const before = await Bun.file(`${device.root}/state/operator/operator.sqlite`).arrayBuffer();
  const calls = await device.herdrCalls();
  const result = await device.run(
    ["dispatch", "--source", "unchecked", "--assignment", "unchecked"],
    { cwd: linked },
  );
  expect(result.code).toBe(3);
  const recovery = z.object({ next: z.object({ command: z.string() }) }).parse(result.output);
  expect(result.output).toMatchObject({
    reason: "linked_checkout",
    next: {
      command: `git --git-dir '${device.root}/owner'\\''s $(touch injected)/.git' worktree list`,
      why: "Locate the controlling checkout, then run the Operator command there.",
    },
    state: { gitDir: `${controller}/.git/worktrees/linked`, commonDir: `${controller}/.git` },
  });
  const located = await device.exec(["sh", "-c", recovery.next.command], device.main);
  expect(located.code, located.stderr).toBe(0);
  expect(located.stdout).toContain(controller);
  expect(await Bun.file(`${device.main}/injected`).exists()).toBe(false);
  expect(await Bun.file(`${device.root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(
    before,
  );
  expect(await device.herdrCalls()).toEqual(calls);
});

test.each(["pane", "worktree"] as const)(
  "promotion recovery distinguishes a %s report from a lost promoted worktree",
  async (resources) => {
    device = await workerDevice();
    const assignment: Record<string, unknown> = {
      key: "read",
      trackerKey: "github:example/one#11",
      instructions: "Investigate the module.",
      completion: "report",
      resources,
      dependencies: [],
    };
    if (resources === "worktree") assignment.branch = "report/read";
    const source = await device.register({
      trackerKey: "github:example/one#10",
      assignments: [assignment],
    });
    const worker = await device.dispatch(source, "read");
    const report = await device.writeJson("report.json", {
      conclusion: "Implement it.",
      evidence: ["src/a.ts:1"],
      unresolved: [],
    });
    expect(
      (await device.run(["report", "submit", "--file", report], { pane: worker.paneId })).code,
    ).toBe(0);
    expect(
      (await device.exec(["herdr", "pane", "exit", worker.paneId, "w1"], device.main)).code,
    ).toBe(0);
    const promotion = await device.writeJson("promotion.json", {
      key: "build",
      trackerKey: "github:example/one#12",
      instructions: "Build the accepted report.",
      branch: "task/build",
    });
    const database = Bun.file(`${device.root}/state/operator/operator.sqlite`);
    const beforePromotion = await database.arrayBuffer();
    const accepted = await device.run([
      "report",
      "accept",
      "--source",
      source,
      "--assignment",
      "read",
      "--promote",
      promotion,
    ]);
    if (resources === "pane") {
      expect(accepted).toMatchObject({
        code: 3,
        output: {
          reason: "promotion_worktree_missing",
          next: {
            decider: "super-agent",
            question:
              "Should the report be accepted without promotion and a new source registered instead?",
          },
        },
      });
      expect(await database.arrayBuffer()).toEqual(beforePromotion);
      return;
    }
    expect(accepted.code, accepted.stderr).toBe(0);
    expect(
      (
        await device.exec(
          ["git", "worktree", "remove", "--force", worker.worktreePath ?? ""],
          device.main,
        )
      ).code,
    ).toBe(0);
    const beforeDispatch = await database.arrayBuffer();
    const calls = await device.herdrCalls();
    expect(
      await device.run(["dispatch", "--source", source, "--assignment", "build"]),
    ).toMatchObject({
      code: 3,
      output: {
        reason: "promotion_worktree_missing",
        next: {
          decider: "person",
          question:
            "How should the missing promoted worktree be recovered without losing unlanded work?",
        },
        state: { reusable: false },
      },
    });
    expect(await database.arrayBuffer()).toEqual(beforeDispatch);
    expect(await device.herdrCalls()).toEqual([
      ...calls,
      "plugin list",
      "workspace list",
      "agent list",
      "tab list",
    ]);
  },
);
