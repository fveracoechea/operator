import { afterEach, beforeEach, expect, test } from "bun:test";
import { Environment } from "../environment/main.ts";
// Bun has no temporary directory or recursive removal API.
import { chmod, lstat, mkdir, mkdtemp, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { registerTestDevice } from "../../scripts/device-fixture.ts";

let root = "";
let databaseBefore: ArrayBuffer;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-device-settings-"));
  databaseBefore = await registerTestDevice(root);
});
const cli = new URL("../../cli.ts", import.meta.url).pathname;
afterEach(async () => {
  try {
    expect(await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(
      databaseBefore,
    );
  } finally {
    await chmod(`${root}/config/operator`, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function run(args: string[], overrides: Record<string, string | undefined> = {}, cwd = root) {
  const child = Bun.spawn([process.execPath, cli, ...args, "--json"], {
    cwd,
    env: Environment.child({
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      ...overrides,
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

test("inspects default device settings without changing registered state or creating settings", async () => {
  const result = await run(["config", "show"]);
  expect(result.code).toBe(0);
  expect(result.output).toMatchObject({
    reason: "settings_read",
    data: {
      path: `${root}/config/operator/config.json`,
      exists: false,
      config: { $schema: "./config.schema.json", superAgent: {}, workerAgent: {} },
    },
  });
  expect(result.stderr).toBe("");
  expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, dot: true }))).toEqual([
    "state/operator/operator.sqlite",
  ]);
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(
    databaseBefore,
  );
});

test.each(["XDG_CONFIG_HOME", "XDG_STATE_HOME", "HOME", "TMPDIR"])(
  "refuses invalid %s before a command can write",
  async (name) => {
    for (const value of ["", "relative"]) {
      const result = await run(
        ["config", "apply", "--set", "superAgent.host=opencode", "--plan", "invalid"],
        { [name]: value },
      );
      expect(result.code).toBe(2);
      expect(result.output).toMatchObject({ reason: "invalid_environment" });
      expect(result.stderr).toContain(name);
      expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, dot: true }))).toEqual([
        "state/operator/operator.sqlite",
      ]);
    }
  },
);

test("preserves linked external settings and explains their edit path", async () => {
  await mkdir(`${root}/config/operator`, { recursive: true });
  const text = '{"superAgent":{"host":"claude-code"}}\n';
  await Bun.write(`${root}/external.json`, text);
  await symlink(`${root}/external.json`, `${root}/config/operator/config.json`);
  const shown = await run(["config", "show"]);
  expect(shown.code).toBe(0);
  const planned = await run(["config", "plan", "--set", "workerAgent.host=opencode"]);
  expect(planned.code).toBe(0);
  const id = z.object({ data: z.object({ planId: z.string() }) }).parse(planned.output).data.planId;
  const applied = await run([
    "config",
    "apply",
    "--set",
    "workerAgent.host=opencode",
    "--plan",
    id,
  ]);
  expect(applied.code).toBe(3);
  expect(applied.output).toMatchObject({ reason: "settings_external" });
  expect(applied.stderr).toContain("Nix or Home Manager");
  expect(await readlink(`${root}/config/operator/config.json`)).toBe(`${root}/external.json`);
  expect(await Bun.file(`${root}/external.json`).text()).toBe(text);
  expect(await Bun.file(`${root}/state/operator/config/apply.json`).exists()).toBe(false);
});

test("preserves a read-only regular settings file even when its directory permits rename", async () => {
  await Bun.write(`${root}/config/operator/config.json`, "{}\n", { createPath: true });
  await chmod(`${root}/config/operator/config.json`, 0o444);
  const planned = await run(["config", "plan", "--set", "superAgent.host=opencode"]);
  const id = z.object({ data: z.object({ planId: z.string() }) }).parse(planned.output).data.planId;
  expect(
    (await run(["config", "apply", "--set", "superAgent.host=opencode", "--plan", id])).code,
  ).toBe(3);
  expect(await Bun.file(`${root}/config/operator/config.json`).text()).toBe("{}\n");
  expect((await lstat(`${root}/config/operator/config.json`)).mode.toString(8).slice(-3)).toBe(
    "444",
  );
  expect(await Bun.file(`${root}/state/operator/config/apply.json`).exists()).toBe(false);
});

test("refuses missing and stale plan IDs without replacing settings", async () => {
  const edit = ["--set", "superAgent.host=opencode"];
  expect((await run(["config", "apply", ...edit])).output).toMatchObject({
    reason: "settings_plan_required",
  });
  const planned = await run(["config", "plan", ...edit]);
  const id = z.object({ data: z.object({ planId: z.string() }) }).parse(planned.output).data.planId;
  await Bun.write(`${root}/config/operator/config.json`, "{}\n", { createPath: true });
  expect((await run(["config", "apply", ...edit, "--plan", id])).output).toMatchObject({
    reason: "settings_plan_stale",
  });
  expect(await Bun.file(`${root}/config/operator/config.json`).text()).toBe("{}\n");
  expect(await Bun.file(`${root}/state/operator/config/apply.json`).exists()).toBe(false);
});

test.each(
  [
    ["plan"],
    ["plan", "--set", "crew.host=opencode"],
    ["plan", "--set", "workerAgent.host=unsupported"],
    ["show", "--set", "superAgent.host=opencode"],
    ["show", "--plan", "id"],
    ["apply", "--set"],
    ["apply", "--unknown", "value"],
    ["show", "--json"],
  ].map((args) => ({ args })),
)("refuses invalid settings invocation %j with no writes", async ({ args }) => {
  expect((await run(["config", ...args])).code).toBe(2);
  expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, dot: true }))).toEqual([
    "state/operator/operator.sqlite",
  ]);
});

test("serializes simultaneous applies with real SQLite and records a single completed intent", async () => {
  const edit = [
    "--set",
    "workerAgent.host=claude-code",
    "--set",
    "workerAgent.reasoningEffort=medium",
  ];
  const planned = await run(["config", "plan", ...edit]);
  const id = z.object({ data: z.object({ planId: z.string() }) }).parse(planned.output).data.planId;
  const results = await Promise.all([
    run(["config", "apply", ...edit, "--plan", id]),
    run(["config", "apply", ...edit, "--plan", id]),
  ]);
  expect(results.map((one) => one.code)).toEqual([0, 0]);
  expect(
    results.map((one) => z.object({ reason: z.string() }).parse(one.output).reason).toSorted(),
  ).toEqual(["settings_applied", "settings_unchanged"]);
  expect(await Bun.file(`${root}/state/operator/config/apply.json`).json()).toMatchObject({
    state: "complete",
    planId: id,
  });
});

test("a held settings lock refuses with no settings write", async () => {
  const edit = ["--set", "superAgent.host=opencode"];
  const planned = await run(["config", "plan", ...edit]);
  const id = z.object({ data: z.object({ planId: z.string() }) }).parse(planned.output).data.planId;
  await mkdir(`${root}/state/operator/config`, { recursive: true });
  const lock = new Database(`${root}/state/operator/config/write.sqlite`);
  lock.exec("BEGIN IMMEDIATE");
  try {
    const refused = await run(["config", "apply", ...edit, "--plan", id]);
    expect(refused.code).toBe(1);
    expect(refused.output).toMatchObject({ reason: "settings_io_failed" });
    expect(await Bun.file(`${root}/config/operator/config.json`).exists()).toBe(false);
    expect(await Bun.file(`${root}/state/operator/config/apply.json`).exists()).toBe(false);
  } finally {
    lock.exec("ROLLBACK");
    lock.close();
  }
  expect((await run(["config", "apply", ...edit, "--plan", id])).code).toBe(0);
}, 15_000);

test("retains an unconfirmed intent and recovers without changing settings", async () => {
  const edit = ["--set", "superAgent.host=opencode"];
  const planned = await run(["config", "plan", ...edit]);
  const id = z.object({ data: z.object({ planId: z.string() }) }).parse(planned.output).data.planId;
  await Bun.write(`${root}/config/operator/config.json.tmp`, "unowned temporary file\n", {
    createPath: true,
  });
  const applied = await run(["config", "apply", ...edit, "--plan", id]);
  expect(applied.code).toBe(5);
  expect(applied.output).toMatchObject({ reason: "settings_write_unconfirmed" });
  expect(await Bun.file(`${root}/config/operator/config.json`).exists()).toBe(false);
  expect(await Bun.file(`${root}/config/operator/config.json.tmp`).text()).toBe(
    "unowned temporary file\n",
  );
  expect((await run(["config", "plan", ...edit])).output).toMatchObject({
    reason: "settings_recovery_required",
  });
  expect((await run(["config", "recover"])).output).toMatchObject({ data: { state: "aborted" } });
  expect(await Bun.file(`${root}/config/operator/config.json`).exists()).toBe(false);
});

test("recovery confirms after bytes but preserves unmatched and unreadable receipts", async () => {
  const edit = ["--set", "superAgent.host=opencode"];
  const planned = await run(["config", "plan", ...edit]);
  const data = z
    .object({
      data: z.object({
        planId: z.string(),
        generation: z.string().nullable(),
        editsIdentity: z.string(),
        previousIdentity: z.string(),
        nextIdentity: z.string(),
        nextText: z.string(),
      }),
    })
    .parse(planned.output).data;
  const receipt = {
    planId: data.planId,
    generation: data.generation,
    editsIdentity: data.editsIdentity,
    previousIdentity: data.previousIdentity,
    nextIdentity: data.nextIdentity,
    state: "pending",
  };
  await Bun.write(`${root}/state/operator/config/apply.json`, JSON.stringify(receipt), {
    createPath: true,
  });
  await Bun.write(`${root}/config/operator/config.json`, data.nextText, { createPath: true });
  expect((await run(["config", "recover"])).output).toMatchObject({ data: { state: "complete" } });
  for (const text of [JSON.stringify({ ...receipt, nextIdentity: "unmatched" }), "unreadable"]) {
    await Bun.write(`${root}/state/operator/config/apply.json`, text);
    expect((await run(["config", "recover"])).output).toMatchObject({
      reason: "settings_recovery_required",
    });
    expect(await Bun.file(`${root}/state/operator/config/apply.json`).text()).toBe(text);
    expect(await Bun.file(`${root}/config/operator/config.json`).text()).toBe(data.nextText);
  }
});

test("skips read-only editor support without replacing its link", async () => {
  await mkdir(`${root}/config/operator`, { recursive: true });
  await Bun.write(`${root}/external-schema.json`, "external schema\n");
  await chmod(`${root}/external-schema.json`, 0o444);
  await symlink(`${root}/external-schema.json`, `${root}/config/operator/config.schema.json`);
  const edit = ["--set", "superAgent.host=opencode"];
  const planned = await run(["config", "plan", ...edit]);
  const id = z.object({ data: z.object({ planId: z.string() }) }).parse(planned.output).data.planId;
  expect((await run(["config", "apply", ...edit, "--plan", id])).code).toBe(0);
  expect(await readlink(`${root}/config/operator/config.schema.json`)).toBe(
    `${root}/external-schema.json`,
  );
  expect(await Bun.file(`${root}/external-schema.json`).text()).toBe("external schema\n");
});

test("settings ignore the Git checkout and do not create project instructions or records", async () => {
  const project = `${root}/project`;
  await mkdir(`${project}/nested`, { recursive: true });
  const git = Bun.spawn(["git", "init", "-q", project], { stdout: "pipe", stderr: "pipe" });
  expect(await git.exited).toBe(0);
  const untouched = `${project}/.operator/unfinished`;
  await Bun.write(untouched, "old work\n", { createPath: true });
  const shown = await run(["config", "show"], { PATH: `${root}/no-tools` }, `${project}/nested`);
  expect(shown.code).toBe(0);
  expect(shown.output).toMatchObject({ data: { path: `${root}/config/operator/config.json` } });
  expect(await Bun.file(untouched).text()).toBe("old work\n");
  expect(
    (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: project, dot: true }))).filter(
      (file) => !file.startsWith(".git/"),
    ),
  ).toEqual([".operator/unfinished"]);
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(
    databaseBefore,
  );
});

test("plans and applies an exact device edit once, with a receipt and no checkout changes", async () => {
  const planned = await run(["config", "plan", "--set", "superAgent.host=opencode"]);
  expect(planned.code).toBe(0);
  const plan = z
    .object({ data: z.object({ planId: z.string(), nextText: z.string() }) })
    .parse(planned.output).data;
  expect(await Bun.file(`${root}/config/operator/config.json`).exists()).toBe(false);
  expect(await Bun.file(`${root}/state/operator/config/apply.json`).exists()).toBe(false);
  const args = ["config", "apply", "--set", "superAgent.host=opencode", "--plan", plan.planId];
  const applied = await run(args);
  expect(applied).toMatchObject({ code: 0 });
  expect(applied.output).toMatchObject({ reason: "settings_applied" });
  expect(await Bun.file(`${root}/config/operator/config.json`).text()).toBe(plan.nextText);
  expect(await Bun.file(`${root}/state/operator/config/apply.json`).json()).toMatchObject({
    state: "complete",
    planId: plan.planId,
  });
  expect((await run(args)).output).toMatchObject({
    reason: "settings_unchanged",
    data: { repeated: true },
  });
  const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, dot: true }));
  expect(files.toSorted()).toEqual([
    "config/operator/config.json",
    "config/operator/config.schema.json",
    "state/operator/config/apply.json",
    "state/operator/config/write.sqlite",
    "state/operator/operator.sqlite",
  ]);
});
