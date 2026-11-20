import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import { z } from "zod";
import { workerDevice } from "./worker-fixture.ts";

let device: Awaited<ReturnType<typeof workerDevice>>;
beforeEach(async () => {
  device = await workerDevice();
}, 60000);
afterEach(async () => {
  await rm(device.root, { recursive: true, force: true });
}, 60000);

const audit = {
  completion: "report",
  resources: "pane",
  guide: "audit/SKILL.md",
  profile: "careful",
  workPhases: [{ name: "inspect", goal: "Inspect the queue evidence." }],
};

async function editKind(definition: typeof audit) {
  const edit = ["--set", `kinds.audit=${JSON.stringify(definition)}`];
  const planned = await device.run(["config", "plan", ...edit]);
  expect(planned.code, planned.stderr).toBe(0);
  const id = z.object({ data: z.object({ planId: z.string() }) }).parse(planned.output).data.planId;
  const applied = await device.run(["config", "apply", ...edit, "--plan", id]);
  expect(applied.code, applied.stderr).toBe(0);
}

const launchSchema = z.object({
  data: z.object({
    sourceId: z.string(),
    assignment: z.string(),
    brief: z.string(),
    kind: z.looseObject({ name: z.string(), guide: z.string() }),
  }),
});

test.each([
  { completion: "report", resources: "pane" },
  { completion: "report", resources: "worktree" },
  { completion: "pr", resources: "worktree" },
])(
  "one-off and plan share custom kind defaults and launch snapshots: $completion $resources",
  async ({ completion, resources }) => {
    await Bun.write(`${device.root}/home/.agents/skills/audit/SKILL.md`, "# Audit\n", {
      createPath: true,
    });
    await editKind({ ...audit, completion, resources });
    const oneOff = await device.run(["dispatch", "--kind", "audit", "--brief", "-"], {
      stdin: "Inspect queue.",
    });
    expect(oneOff.code, oneOff.stderr).toBe(0);
    const first = launchSchema.parse(oneOff.output).data;
    const assignment: {
      key: string;
      trackerKey: string;
      kind: string;
      instructions: string;
      dependencies: string[];
      branch?: string;
    } = {
      key: "inspect",
      trackerKey: "audit:plan",
      kind: "audit",
      instructions: "Inspect queue.",
      dependencies: [],
    };
    if (resources === "worktree") assignment.branch = "task/audit";
    const sourceId = await device.register({
      trackerKey: "plan:audit",
      assignments: [assignment],
    });
    const dispatched = await device.run([
      "dispatch",
      "--source",
      sourceId,
      "--assignment",
      "inspect",
    ]);
    expect(dispatched.code, dispatched.stderr).toBe(0);
    const second = launchSchema.parse(dispatched.output).data;
    expect(first.kind).toEqual(second.kind);
    expect(first.kind).toMatchObject({
      name: "audit",
      completion,
      resources,
      profile: "careful",
      workPhases: audit.workPhases,
      guide: `${device.root}/home/.agents/skills/audit/SKILL.md`,
      readsNote: false,
    });
    for (const launch of [first, second]) {
      const shown = await device.run(["source", "show", "--source", launch.sourceId]);
      expect(shown.output).toMatchObject({
        data: {
          plan: { assignments: [{ kind: "audit", completion, resources, profile: "careful" }] },
          launches: [{ kind: first.kind, profile: "careful", reasoningEffort: "high" }],
        },
      });
      const brief = await Bun.file(launch.brief).text();
      expect(brief).toContain(`- Guide: \`${first.kind.guide}\`.`);
      expect(brief).toContain("Inspect queue.");
    }
    const beforeBrief = await Bun.file(first.brief).text();
    await editKind({
      ...audit,
      completion,
      resources,
      profile: "claude",
      workPhases: [{ name: "changed", goal: "Inspect new evidence." }],
    });
    for (const launch of [first, second]) {
      expect(
        (await device.run(["source", "show", "--source", launch.sourceId])).output,
      ).toMatchObject({
        data: { launches: [{ kind: first.kind, profile: "careful", reasoningEffort: "high" }] },
      });
    }
    expect(await Bun.file(first.brief).text()).toBe(beforeBrief);
    await Bun.write(`${device.root}/claude-skills/audit/SKILL.md`, "# Audit\n", {
      createPath: true,
    });
    const future = await device.run(["dispatch", "--kind", "audit", "--brief", "-"], {
      stdin: "Inspect new queue.",
    });
    expect(future.code, future.stderr).toBe(0);
    expect(future.output).toMatchObject({
      data: {
        kind: {
          profile: "claude",
          workPhases: [{ name: "changed", goal: "Inspect new evidence." }],
        },
      },
    });
  },
  60000,
);

test("ask and one-off answer share the plan's built-in snapshot and pane defaults", async () => {
  const asked = await device.run(["ask", "--file", "-", "--profile", "careful"], {
    stdin: "Explain queue.",
  });
  const oneOff = await device.run(
    ["dispatch", "--kind", "answer", "--brief", "-", "--profile", "careful"],
    { stdin: "Explain queue." },
  );
  const sourceId = await device.register({
    trackerKey: "plan:answer",
    assignments: [
      {
        key: "answer",
        trackerKey: "answer:plan",
        kind: "answer",
        instructions: "Explain queue.",
        dependencies: [],
        profile: "careful",
      },
    ],
  });
  const planned = await device.run(["dispatch", "--source", sourceId, "--assignment", "answer"]);
  expect([asked.code, oneOff.code, planned.code]).toEqual([0, 0, 0]);
  const expected = launchSchema.parse(planned.output).data.kind;
  expect(expected).toMatchObject({ name: "answer", completion: "report", resources: "pane" });
  for (const result of [asked, oneOff]) {
    const launch = launchSchema.parse(result.output).data;
    expect(launch.kind).toEqual(expected);
    expect(
      (await device.run(["source", "show", "--source", launch.sourceId])).output,
    ).toMatchObject({
      data: {
        plan: {
          assignments: [
            { kind: "answer", completion: "report", resources: "pane", profile: "careful" },
          ],
        },
        launches: [{ kind: expected, worktreePath: null, reasoningEffort: "high" }],
      },
    });
  }
}, 60000);

test.each([
  { rule: "built-in reuse", name: "answer", change: {} },
  { rule: "invalid completion", name: "audit", change: { completion: "task" } },
  { rule: "empty phases", name: "audit", change: { workPhases: [] } },
  {
    rule: "unknown guard",
    name: "audit",
    change: { workPhases: [{ name: "inspect", goal: "Inspect.", guard: "shell_command" }] },
  },
  { rule: "cross-completion next kind", name: "audit", change: { nextKind: "implementation" } },
  { rule: "missing installed guide", name: "audit", change: { guide: "missing/SKILL.md" } },
])(
  "dispatch, ask and plan use actual settings validation without effects: $rule",
  async ({ name, change }) => {
    await Bun.write(`${device.root}/home/.agents/skills/audit/SKILL.md`, "# Audit\n", {
      createPath: true,
    });
    const file = `${device.root}/config/operator/config.json`;
    const config = z.looseObject({}).parse(await Bun.file(file).json());
    await Bun.write(
      file,
      JSON.stringify({ ...config, kinds: { [name]: { ...audit, ...change } } }),
    );
    const plan = await device.writeJson("audit-plan.json", {
      trackerKey: "plan:audit",
      assignments: [
        {
          key: "audit",
          trackerKey: "audit:plan",
          kind: name,
          instructions: "Inspect queue.",
          dependencies: [],
        },
      ],
    });
    const before = await Bun.file(`${device.root}/state/operator/operator.sqlite`).arrayBuffer();
    const calls = await device.herdrCalls();
    for (const command of [
      ["dispatch", "--kind", name, "--brief", "-"],
      ["ask", "--file", "-"],
      ["source", "register", "--file", plan],
    ]) {
      const result = await device.run(command, { stdin: "Inspect queue." });
      expect(result.code, JSON.stringify(result)).toBe(3);
      expect(result.output).toMatchObject({
        reason: "invalid_settings",
        state: { settingsValid: false },
        next: { decider: "super-agent" },
      });
      expect(await Bun.file(`${device.root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(
        before,
      );
      expect(await device.herdrCalls()).toEqual(calls);
    }
  },
  60000,
);

test("one-off and plan enforce the selected host's installed-guide policy", async () => {
  await Bun.write(`${device.root}/claude-skills/audit/SKILL.md`, "# Audit\n", { createPath: true });
  await editKind(audit);
  const sourceId = await device.register({
    trackerKey: "plan:audit",
    assignments: [
      {
        key: "audit",
        trackerKey: "audit:plan",
        kind: "audit",
        instructions: "Inspect queue.",
        dependencies: [],
      },
    ],
  });
  for (const command of [
    ["dispatch", "--kind", "audit", "--brief", "-"],
    ["dispatch", "--source", sourceId, "--assignment", "audit"],
  ]) {
    const refused = await device.run(command, { stdin: "Inspect queue." });
    expect(refused).toMatchObject({
      code: 3,
      output: { reason: "invalid_settings", state: { settingsValid: false } },
    });
    expect(refused.stderr).toContain("No installed guide skill for opencode");
  }
  expect(await device.herdrCalls()).not.toContain("agent start");
}, 60000);
