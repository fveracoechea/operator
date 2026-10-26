import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { z } from "zod";
import { Database } from "bun:sqlite";

let root = "";
const cli = Bun.fileURLToPath(new URL("../../cli.ts", import.meta.url));
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-sources-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function run(cwd: string, args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args, "--json"], {
    cwd,
    env: Environment.child({
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      PATH: `${root}/tools:${Environment.read().PATH ?? ""}`,
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: JSON.parse(stdout) as unknown, stderr };
}

async function repository(name = "checkout", remote = "example/one") {
  const cwd = `${root}/${name}`;
  await mkdir(cwd);
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["remote", "add", "origin", `https://github.com/${remote}.git`],
  ]) {
    const child = Bun.spawn(["git", ...args], {
      cwd,
      env: Environment.child({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  }
  expect((await run(cwd, ["project", "register"])).code).toBe(0);
  return cwd;
}

async function prohibitExternalTools() {
  for (const tool of ["gh", "herdr", "opencode", "claude"]) {
    await Bun.write(
      `${root}/tools/${tool}`,
      `#!${process.execPath}\nawait Bun.write(${JSON.stringify(`${root}/external-called`)}, "prohibited"); process.exit(99);\n`,
      { createPath: true },
    );
    await chmod(`${root}/tools/${tool}`, 0o755);
  }
}

const plan = {
  trackerKey: "github:example/one#10",
  assignments: [
    {
      key: "investigate",
      trackerKey: "github:example/one#11",
      instructions: "Read and report. Ask the person when authority is unclear.",
      completion: "report",
      resources: "pane",
      dependencies: [],
    },
    {
      key: "implement",
      trackerKey: "github:example/one#12",
      instructions: "Implement the accepted report.",
      completion: "pr",
      resources: "worktree",
      branch: "task/12-implement",
      dependencies: ["investigate"],
    },
  ],
};

test("registers a supplied mixed plan and derives ready assignments and waits without changing the checkout", async () => {
  const cwd = await repository();
  await prohibitExternalTools();
  await Bun.write(`${root}/plan.json`, JSON.stringify(plan));
  const registered = await run(cwd, ["source", "register", "--file", `${root}/plan.json`]);
  expect(registered.code, registered.stderr).toBe(0);
  expect(registered.output).toMatchObject({
    reason: "source_registered",
    data: { repository: "example/one", trackerKey: plan.trackerKey, state: "open", plan },
  });
  const id = z.object({ data: z.object({ id: z.uuid() }) }).parse(registered.output).data.id;
  expect(await run(cwd, ["source", "show", "--source", id])).toMatchObject({
    code: 0,
    output: { data: { id, plan } },
  });
  const next = await run(cwd, ["next"]);
  expect(next).toMatchObject({
    code: 0,
    output: {
      reason: "next_actions_read",
      data: {
        sources: [
          {
            id,
            actions: [{ action: "ready_assignment", assignment: "investigate" }],
            waits: [
              {
                assignment: "implement",
                reason: "dependencies_pending",
                blockers: [
                  {
                    assignment: "investigate",
                    completion: "report",
                    state: "ready",
                    required: "completed",
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  });
  expect(
    await Array.fromAsync(new Bun.Glob("*").scan({ cwd, dot: true, onlyFiles: false })),
  ).toEqual([".git"]);
  expect(await Bun.file(`${root}/external-called`).exists()).toBe(false);
});

test("rejects a second open parent atomically, including simultaneous registration", async () => {
  const cwd = await repository();
  await Bun.write(`${root}/plan.json`, JSON.stringify(plan));
  const results = await Promise.all([
    run(cwd, ["source", "register", "--file", `${root}/plan.json`]),
    run(cwd, ["source", "register", "--file", `${root}/plan.json`]),
  ]);
  expect(results.map((result) => result.code).toSorted((a, b) => a - b)).toEqual([0, 4]);
  expect(results.find((result) => result.code === 4)?.output).toMatchObject({
    reason: "source_parent_open",
  });
  using db = new Database(`${root}/state/operator/operator.sqlite`, { readonly: true });
  expect(db.query("SELECT * FROM sources").all()).toHaveLength(1);
  expect(db.query("SELECT * FROM assignments").all()).toHaveLength(2);
});

test("empty sources end at registration and later registrations get new project-scoped identities", async () => {
  const one = await repository();
  const two = await repository("other", "example/two");
  expect(await run(one, ["next"])).toMatchObject({ code: 0, output: { data: { sources: [] } } });
  await Bun.write(
    `${root}/empty.json`,
    JSON.stringify({ trackerKey: plan.trackerKey, assignments: [] }),
  );
  const ids: string[] = [];
  for (const cwd of [one, one, two]) {
    const result = await run(cwd, ["source", "register", "--file", `${root}/empty.json`]);
    expect(result.code, result.stderr).toBe(0);
    const source = z
      .object({
        data: z.object({
          id: z.uuid(),
          registeredAt: z.string(),
          endedAt: z.string(),
          state: z.literal("finished"),
        }),
      })
      .parse(result.output).data;
    expect(source.endedAt).toBe(source.registeredAt);
    ids.push(source.id);
    expect(await run(cwd, ["next", "--source", source.id])).toMatchObject({
      code: 0,
      output: {
        data: {
          sources: [
            {
              id: source.id,
              state: "finished",
              actions: [{ action: "source_ended", reason: "finished" }],
              waits: [],
            },
          ],
        },
      },
    });
  }
  expect(new Set(ids).size).toBe(3);
  expect(await run(two, ["source", "show", "--source", ids[0] ?? ""])).toMatchObject({
    code: 3,
    output: { reason: "source_not_found" },
  });
  const before = await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer();
  expect(
    z
      .object({ data: z.object({ sources: z.array(z.unknown()) }) })
      .parse((await run(one, ["next"])).output).data.sources,
  ).toHaveLength(2);
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(before);
});

test.each([
  {
    name: "unknown dependency",
    assignments: [{ ...plan.assignments[0], dependencies: ["missing"] }],
  },
  {
    name: "self dependency",
    assignments: [{ ...plan.assignments[0], dependencies: ["investigate"] }],
  },
  {
    name: "cycle",
    assignments: [{ ...plan.assignments[0], dependencies: ["implement"] }, plan.assignments[1]],
  },
  { name: "duplicate key", assignments: [plan.assignments[0], plan.assignments[0]] },
  {
    name: "duplicate dependency",
    assignments: [
      plan.assignments[0],
      { ...plan.assignments[1], dependencies: ["investigate", "investigate"] },
    ],
  },
  {
    name: "PR without worktree",
    assignments: [{ ...plan.assignments[1], resources: "pane", dependencies: [] }],
  },
  {
    name: "invalid branch",
    assignments: [{ ...plan.assignments[1], branch: "bad..branch", dependencies: [] }],
  },
  { name: "empty instructions", assignments: [{ ...plan.assignments[0], instructions: "  " }] },
  {
    name: "cross-source reference",
    assignments: [{ ...plan.assignments[0], dependencies: ["other-source/investigate"] }],
  },
  { name: "unknown field", assignments: [{ ...plan.assignments[0], approvalPlan: {} }] },
])("refuses $name before any plan writes", async ({ assignments }) => {
  const cwd = await repository();
  await Bun.write(`${root}/plan.json`, JSON.stringify({ ...plan, assignments }));
  const before = await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer();
  expect(await run(cwd, ["source", "register", "--file", `${root}/plan.json`])).toMatchObject({
    code: 2,
    output: { reason: "invalid_source_plan" },
  });
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(before);
});

test("accepts selected profiles without launching a host, and refuses absent profiles without writes", async () => {
  const cwd = await repository();
  await prohibitExternalTools();
  await Bun.write(
    `${root}/plan.json`,
    JSON.stringify({ ...plan, assignments: [{ ...plan.assignments[0], profile: "research" }] }),
  );
  const before = await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer();
  expect(await run(cwd, ["source", "register", "--file", `${root}/plan.json`])).toMatchObject({
    code: 3,
    output: { reason: "source_profile_missing" },
  });
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(before);
  await Bun.write(
    `${root}/config/operator/config.json`,
    JSON.stringify({
      profiles: { research: { host: "claude-code", model: "configured-not-launched" } },
    }),
    { createPath: true },
  );
  const result = await run(cwd, ["source", "register", "--file", `${root}/plan.json`]);
  expect(result).toMatchObject({
    code: 0,
    output: { data: { plan: { assignments: [{ profile: "research" }] } } },
  });
  expect(await Bun.file(`${root}/external-called`).exists()).toBe(false);
});

test("a held writer refuses source registration without partial records", async () => {
  const cwd = await repository();
  await Bun.write(`${root}/plan.json`, JSON.stringify(plan));
  using db = new Database(`${root}/state/operator/operator.sqlite`);
  db.exec("BEGIN IMMEDIATE");
  try {
    expect(await run(cwd, ["source", "register", "--file", `${root}/plan.json`])).toMatchObject({
      code: 1,
      output: { reason: "state_busy" },
    });
    expect(db.query("SELECT * FROM sources").all()).toEqual([]);
    expect(db.query("SELECT * FROM assignments").all()).toEqual([]);
  } finally {
    db.exec("ROLLBACK");
  }
  expect((await run(cwd, ["source", "register", "--file", `${root}/plan.json`])).code).toBe(0);
}, 15000);

test("next uses completion-type-specific dependency facts and leaves all records unchanged", async () => {
  const cwd = await repository();
  const mixed = {
    ...plan,
    assignments: [
      plan.assignments[0],
      { ...plan.assignments[1], dependencies: [] },
      { ...plan.assignments[0], key: "consumer", dependencies: ["investigate", "implement"] },
    ],
  };
  await Bun.write(`${root}/plan.json`, JSON.stringify(mixed));
  expect((await run(cwd, ["source", "register", "--file", `${root}/plan.json`])).code).toBe(0);
  for (const [report, pr, blocked] of [
    ["reported", "pr-open", true],
    ["completed", "running", true],
    ["completed", "pr-open", false],
    ["completed", "merged", false],
  ] as const) {
    {
      using db = new Database(`${root}/state/operator/operator.sqlite`);
      db.query("UPDATE assignments SET state = ? WHERE key = 'investigate'").run(report);
      db.query("UPDATE assignments SET state = ? WHERE key = 'implement'").run(pr);
    }
    const before = await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer();
    const next = z
      .object({
        data: z.object({
          sources: z.array(
            z.object({
              actions: z.array(z.object({ assignment: z.string() })),
              waits: z.array(z.object({ assignment: z.string() })),
            }),
          ),
        }),
      })
      .parse((await run(cwd, ["next"])).output).data.sources[0];
    expect(next?.actions.some((action) => action.assignment === "consumer")).toBe(!blocked);
    expect(next?.waits.some((wait) => wait.assignment === "consumer")).toBe(blocked);
    expect(await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(before);
  }
});

test.each(["missing-row", "extra-row", "changed-completion", "invalid-state"])(
  "refuses corrupt %s source records without writes",
  async (mode) => {
    const cwd = await repository();
    await Bun.write(`${root}/plan.json`, JSON.stringify(plan));
    const registered = await run(cwd, ["source", "register", "--file", `${root}/plan.json`]);
    expect(registered.code).toBe(0);
    const id = z.object({ data: z.object({ id: z.string() }) }).parse(registered.output).data.id;
    {
      using db = new Database(`${root}/state/operator/operator.sqlite`);
      if (mode === "missing-row") db.exec("DELETE FROM assignments WHERE key = 'implement'");
      if (mode === "extra-row")
        db.exec(
          "INSERT INTO assignments SELECT source_id, 'extra', 'report', 'ready' FROM assignments LIMIT 1",
        );
      if (mode === "changed-completion")
        db.exec("UPDATE assignments SET completion = 'report' WHERE key = 'implement'");
      if (mode === "invalid-state")
        db.exec("UPDATE assignments SET state = 'reported' WHERE key = 'implement'");
    }
    const before = await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer();
    for (const args of [["next"], ["source", "show", "--source", id]]) {
      expect(await run(cwd, args)).toMatchObject({ code: 3, output: { reason: "state_corrupt" } });
    }
    expect(await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(before);
  },
);

test.each(["open-completed", "finished-ready", "open-ended", "finished-no-end", "reset-ready"])(
  "refuses inconsistent %s source lifecycles without changing records",
  async (mode) => {
    const cwd = await repository();
    await Bun.write(
      `${root}/plan.json`,
      JSON.stringify({ ...plan, assignments: [plan.assignments[0]] }),
    );
    const registered = await run(cwd, ["source", "register", "--file", `${root}/plan.json`]);
    expect(registered.code).toBe(0);
    const id = z.object({ data: z.object({ id: z.string() }) }).parse(registered.output).data.id;
    {
      using db = new Database(`${root}/state/operator/operator.sqlite`);
      if (mode === "open-completed") db.exec("UPDATE assignments SET state = 'completed'");
      if (mode === "finished-ready")
        db.exec("UPDATE sources SET state = 'finished', ended_at = 'later'");
      if (mode === "open-ended") db.exec("UPDATE sources SET ended_at = 'later'");
      if (mode === "finished-no-end")
        db.exec(
          "UPDATE assignments SET state = 'completed'; UPDATE sources SET state = 'finished'",
        );
      if (mode === "reset-ready") db.exec("UPDATE sources SET state = 'reset', ended_at = 'later'");
    }
    const before = await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer();
    for (const args of [["next"], ["source", "show", "--source", id]])
      expect(await run(cwd, args)).toMatchObject({ code: 3, output: { reason: "state_corrupt" } });
    expect(await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(before);
  },
);

test("branch inputs match Git for HEAD and the valid at-sign name", async () => {
  const cwd = await repository();
  for (const branch of ["HEAD", "@"]) {
    await Bun.write(
      `${root}/plan.json`,
      JSON.stringify({
        ...plan,
        assignments: [{ ...plan.assignments[1], branch, dependencies: [] }],
      }),
    );
    const before = await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer();
    const git = Bun.spawn(["git", "check-ref-format", "--branch", branch], {
      cwd,
      env: Environment.child({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }),
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await git.exited).toBe(branch === "HEAD" ? 128 : 0);
    const result = await run(cwd, ["source", "register", "--file", `${root}/plan.json`]);
    expect(result.code, result.stderr).toBe(branch === "HEAD" ? 2 : 0);
    if (branch === "HEAD")
      expect(await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(
        before,
      );
  }
});

test.each(["finished", "reset"])(
  "a recorded %s source permits a fresh registration of the same parent",
  async (state) => {
    const cwd = await repository();
    await Bun.write(`${root}/plan.json`, JSON.stringify(plan));
    const first = await run(cwd, ["source", "register", "--file", `${root}/plan.json`]);
    expect(first.code).toBe(0);
    const id = z.object({ data: z.object({ id: z.string() }) }).parse(first.output).data.id;
    {
      using db = new Database(`${root}/state/operator/operator.sqlite`);
      db.exec(
        state === "finished"
          ? "UPDATE assignments SET state = CASE completion WHEN 'pr' THEN 'merged' ELSE 'completed' END"
          : "UPDATE assignments SET state = 'abandoned'",
      );
      db.query("UPDATE sources SET state = ?, ended_at = '2026-10-26T14:00:00Z'").run(state);
    }
    expect(await run(cwd, ["next", "--source", id])).toMatchObject({
      code: 0,
      output: {
        data: {
          sources: [{ id, state, actions: [{ action: "source_ended", reason: state }], waits: [] }],
        },
      },
    });
    const later = await run(cwd, ["source", "register", "--file", `${root}/plan.json`]);
    expect(later.code, later.stderr).toBe(0);
    expect(z.object({ data: z.object({ id: z.string() }) }).parse(later.output).data.id).not.toBe(
      id,
    );
    expect(await run(cwd, ["source", "show", "--source", id])).toMatchObject({
      code: 0,
      output: { data: { id, state } },
    });
  },
);
