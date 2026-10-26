import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory, chmod, or recursive removal API.
import { chmod, mkdtemp, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Environment } from "../environment/main.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-profiles-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function run(args: string[], overrides: Record<string, string | undefined> = {}) {
  const child = Bun.spawn(
    [
      process.execPath,
      Bun.fileURLToPath(new URL("../../cli.ts", import.meta.url)),
      ...args,
      "--json",
    ],
    {
      cwd: root,
      env: Environment.child({
        HOME: `${root}/home`,
        XDG_CONFIG_HOME: `${root}/config`,
        XDG_STATE_HOME: `${root}/state`,
        PATH: `${root}/bin:${Environment.read().PATH}`,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        ...overrides,
      }),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: JSON.parse(stdout) as unknown, stderr };
}

test("edits an extensible named profile through protected config commands", async () => {
  const edits = ["--set", "profiles.investigation.reasoningEffort=high"];
  const planned = await run(["config", "plan", ...edits]);
  expect(planned.code).toBe(0);
  const id = z.object({ data: z.object({ planId: z.string() }) }).parse(planned.output).data.planId;
  const applied = await run(["config", "apply", ...edits, "--plan", id]);
  expect(applied.code).toBe(0);
  expect((await run(["config", "show"])).output).toMatchObject({
    data: { config: { profiles: { investigation: { reasoningEffort: "high" } } } },
  });
});

async function openCode(efforts = ["low", "medium", "high"]) {
  await Bun.write(
    `${root}/bin/opencode`,
    `#!${process.execPath}\nconst args=process.argv.slice(2);\nawait Bun.write(${JSON.stringify(`${root}/calls.json`)}, JSON.stringify(args));\nconsole.log(JSON.stringify({location:{directory:${JSON.stringify(root)}},data:[{providerID:"test",id:"reasoner",enabled:true,variants:${JSON.stringify(efforts.map((id) => ({ id })))} }]}));\n`,
    { createPath: true },
  );
  await chmod(`${root}/bin/opencode`, 0o755);
}

test("stores advertised custom OpenCode effort in device defaults and named profiles", async () => {
  await openCode(["medium", "high", "deep"]);
  await Bun.write(
    `${root}/config/operator/config.json`,
    JSON.stringify({ superAgent: { host: "opencode", model: "test/reasoner" } }),
    { createPath: true },
  );
  const edits = [
    "--set",
    "superAgent.reasoningEffort=deep",
    "--set",
    "profiles.investigation.reasoningEffort=deep",
  ];
  const planned = await run(["config", "plan", ...edits]);
  expect(planned.code).toBe(0);
  const planId = z.object({ data: z.object({ planId: z.string() }) }).parse(planned.output)
    .data.planId;
  expect((await run(["config", "apply", ...edits, "--plan", planId])).code).toBe(0);
  for (const flags of [
    ["--role", "superAgent"],
    ["--profile", "investigation"],
  ]) {
    const resolved = await run(["config", "resolve", ...flags]);
    expect(resolved.code).toBe(0);
    expect(resolved.output).toMatchObject({
      data: {
        reasoningEffort: "deep",
        command: { args: ["mini", "--model", "test/reasoner#deep"] },
      },
    });
  }
});

test("resolves inherited worker and SuperAgent effort from live host metadata without launching", async () => {
  await openCode();
  await Bun.write(
    `${root}/config/operator/config.json`,
    JSON.stringify({
      superAgent: { host: "opencode", model: "test/reasoner" },
      profiles: { investigation: { reasoningEffort: "low" } },
    }),
    { createPath: true },
  );
  const worker = await run(["config", "resolve"]);
  expect(worker.code).toBe(0);
  expect(worker.output).toMatchObject({
    data: {
      host: "opencode",
      model: "test/reasoner",
      reasoningEffort: "medium",
      command: { tool: "opencode", args: ["mini", "--model", "test/reasoner#medium"] },
    },
  });
  expect((await run(["config", "resolve", "--role", "superAgent"])).output).toMatchObject({
    data: { reasoningEffort: "high" },
  });
  expect((await run(["config", "resolve", "--profile", "investigation"])).output).toMatchObject({
    data: { reasoningEffort: "low", profile: "investigation" },
  });
  expect(await Bun.file(`${root}/calls.json`).json()).toEqual([
    "api",
    "get",
    `/api/model?location%5Bdirectory%5D=${encodeURIComponent(root)}`,
  ]);
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).exists()).toBe(false);
});

test("uses Claude Code metadata and passes only the selected model and effort to its launch command", async () => {
  await Bun.write(
    `${root}/bin/claude`,
    `#!${process.execPath}
const calls={args:process.argv.slice(2),messages:[]};
for await (const chunk of Bun.stdin.stream().pipeThrough(new TextDecoderStream())) {
 for (const line of chunk.trim().split("\\n")) {
  const message=JSON.parse(line); calls.messages.push(message);
  await Bun.write(${JSON.stringify(`${root}/claude-calls.json`)},JSON.stringify(calls));
  if(message.type === "control_request") console.log(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:message.request_id,response:{models:[{value:"precise-model",supportsEffort:true,supportedEffortLevels:["medium","high"]}],commands:[],agents:[]}}}));
 }
}
`,
    { createPath: true },
  );
  await chmod(`${root}/bin/claude`, 0o755);
  const result = await run([
    "config",
    "resolve",
    "--host",
    "claude-code",
    "--model",
    "precise-model",
  ]);
  expect(result.code).toBe(0);
  expect(result.output).toMatchObject({
    data: {
      host: "claude-code",
      model: "precise-model",
      reasoningEffort: "medium",
      command: { tool: "claude", args: ["--model", "precise-model", "--effort", "medium"] },
    },
  });
  const calls = z
    .object({
      args: z.array(z.string()),
      messages: z.array(z.object({ type: z.string(), request: z.object({ subtype: z.string() }) })),
    })
    .parse(await Bun.file(`${root}/claude-calls.json`).json());
  expect(calls.messages.map((message) => [message.type, message.request.subtype])).toEqual([
    ["control_request", "initialize"],
  ]);
  expect(
    calls.args.some((arg) => /permission|allowed.?tools|disallowed.?tools|fallback/i.test(arg)),
  ).toBe(false);
});

test("reports a Claude Code metadata process failure as an operational refusal", async () => {
  await Bun.write(`${root}/bin/claude`, `#!${process.execPath}\nprocess.exit(1);\n`, {
    createPath: true,
  });
  await chmod(`${root}/bin/claude`, 0o755);
  const result = await run(["host", "models", "--host", "claude-code"]);
  expect(result.code).toBe(1);
  expect(result.output).toMatchObject({ reason: "host_metadata_failed" });
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).exists()).toBe(false);
});

test("refuses unsupported explicit edits without settings, receipts, database, or host launches", async () => {
  await openCode();
  const result = await run([
    "config",
    "plan",
    "--set",
    "superAgent.host=opencode",
    "--set",
    "superAgent.model=missing",
  ]);
  expect(result.code).toBe(3);
  expect(result.output).toMatchObject({ reason: "unsupported_model" });
  expect(await Bun.file(`${root}/config/operator/config.json`).exists()).toBe(false);
  expect(await Bun.file(`${root}/state/operator/config/apply.json`).exists()).toBe(false);
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).exists()).toBe(false);
});

test.each([
  { flags: ["--model", "not-in-catalog"], reason: "unsupported_model" },
  { flags: ["--effort", "max"], reason: "unsupported_effort" },
  { flags: ["--profile", "absent"], reason: "profile_missing" },
])("refuses explicit launch choices without substitution: $reason", async ({ flags, reason }) => {
  await openCode();
  const text = JSON.stringify({ superAgent: { host: "opencode", model: "test/reasoner" } });
  await Bun.write(`${root}/config/operator/config.json`, text, { createPath: true });
  const result = await run(["config", "resolve", ...flags]);
  expect(result.code).toBe(3);
  expect(result.output).toMatchObject({ reason });
  expect(await Bun.file(`${root}/config/operator/config.json`).text()).toBe(text);
  expect(await Bun.file(`${root}/state/operator/config/apply.json`).exists()).toBe(false);
});

test("revalidates actual host support at apply before writing settings or receipts", async () => {
  await openCode();
  const edits = ["--set", "superAgent.host=opencode", "--set", "superAgent.model=test/reasoner"];
  const planned = await run(["config", "plan", ...edits]);
  expect(planned.code).toBe(0);
  const id = z.object({ data: z.object({ planId: z.string() }) }).parse(planned.output).data.planId;
  await Bun.write(
    `${root}/bin/opencode`,
    `#!${process.execPath}\nconsole.log(JSON.stringify({location:{directory:${JSON.stringify(root)}},data:[]}));\n`,
  );
  const applied = await run(["config", "apply", ...edits, "--plan", id]);
  expect(applied.code).toBe(3);
  expect(applied.output).toMatchObject({ reason: "unsupported_model" });
  expect(await Bun.file(`${root}/config/operator/config.json`).exists()).toBe(false);
  expect(await Bun.file(`${root}/state/operator/config/apply.json`).exists()).toBe(false);
});

test.each(["link", "read-only"])("protects externally managed %s profiles", async (kind) => {
  await Bun.write(`${root}/config/operator/config.json`, "{}\n", { createPath: true });
  if (kind === "link") {
    await rm(`${root}/config/operator/config.json`);
    await Bun.write(`${root}/external.json`, "{}\n");
    await symlink(`${root}/external.json`, `${root}/config/operator/config.json`);
  } else await chmod(`${root}/config/operator/config.json`, 0o444);
  const edits = ["--set", "profiles.study.reasoningEffort=high"];
  const planned = await run(["config", "plan", ...edits]);
  const id = z.object({ data: z.object({ planId: z.string() }) }).parse(planned.output).data.planId;
  const result = await run(["config", "apply", ...edits, "--plan", id]);
  expect(result.code).toBe(3);
  expect(result.output).toMatchObject({ reason: "settings_external" });
  expect(await Bun.file(`${root}/config/operator/config.json`).text()).toBe("{}\n");
  if (kind === "link")
    expect(await readlink(`${root}/config/operator/config.json`)).toBe(`${root}/external.json`);
  expect(await Bun.file(`${root}/state/operator/config/apply.json`).exists()).toBe(false);
});

test("protects external configuration before making a host metadata request", async () => {
  await openCode();
  const config = `${root}/config/operator/config.json`;
  const text = JSON.stringify({ superAgent: { host: "opencode", model: "test/reasoner" } });
  await Bun.write(config, text, { createPath: true });
  await Bun.write(`${root}/external.json`, text);
  await rm(config);
  await symlink(`${root}/external.json`, config);
  const edits = ["--set", "profiles.study.reasoningEffort=high"];
  const planned = await run(["config", "plan", ...edits]);
  const planId = z.object({ data: z.object({ planId: z.string() }) }).parse(planned.output)
    .data.planId;
  await rm(`${root}/bin/opencode`);
  const result = await run(["config", "apply", ...edits, "--plan", planId], {
    PATH: `${root}/bin`,
  });
  expect(result.code).toBe(3);
  expect(result.output).toMatchObject({ reason: "settings_external" });
  expect(await Bun.file(config).text()).toBe(text);
  expect(await readlink(config)).toBe(`${root}/external.json`);
  expect(await Bun.file(`${root}/state/operator/config/apply.json`).exists()).toBe(false);
});

test("settings edits resolve future selections without changing prior values or the registered project database", async () => {
  for (const args of [
    ["init", "-q"],
    ["remote", "add", "origin", "https://github.com/example/project.git"],
  ]) {
    expect(
      Bun.spawnSync(["git", ...args], {
        cwd: root,
        env: Environment.child({
          HOME: `${root}/home`,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        }),
      }).exitCode,
    ).toBe(0);
  }
  expect((await run(["project", "register"])).code).toBe(0);
  const database = await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer();
  await openCode();
  await Bun.write(
    `${root}/config/operator/config.json`,
    JSON.stringify({ superAgent: { host: "opencode", model: "test/reasoner" } }),
    { createPath: true },
  );
  const prior = await run(["config", "resolve"]);
  const edits = ["--set", "workerAgent.reasoningEffort=high"];
  const planned = await run(["config", "plan", ...edits]);
  const id = z.object({ data: z.object({ planId: z.string() }) }).parse(planned.output).data.planId;
  expect((await run(["config", "apply", ...edits, "--plan", id])).code).toBe(0);
  expect((await run(["config", "resolve"])).output).toMatchObject({
    data: { reasoningEffort: "high" },
  });
  expect(prior.output).toMatchObject({ data: { reasoningEffort: "medium" } });
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(database);
});

test.each(["missing", "invalid"])(
  "reports %s host metadata without creating state",
  async (kind) => {
    await openCode();
    await (kind === "missing"
      ? rm(`${root}/bin/opencode`)
      : Bun.write(`${root}/bin/opencode`, `#!${process.execPath}\nconsole.log("invalid");\n`));
    const result = await run(["host", "models", "--host", "opencode"], { PATH: `${root}/bin` });
    expect(result.code).toBe(kind === "missing" ? 3 : 1);
    expect(result.output).toMatchObject({
      reason: kind === "missing" ? "host_unavailable" : "host_metadata_failed",
    });
    expect(await Bun.file(`${root}/state/operator/operator.sqlite`).exists()).toBe(false);
  },
);
