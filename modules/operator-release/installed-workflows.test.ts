import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no permission or recursive removal API.
import { chmod, rm } from "node:fs/promises";
import { z } from "zod";
import {
  type BuiltRelease,
  installFixture,
  launcherPackage,
  registryPackage,
  run,
  sourceRoot,
  succeed,
} from "./install-fixture.ts";
import { versionSchema } from "./test-schemas.ts";

// The documented workflows run through real installed commands: an exact JSR install from the
// local registry fake with its launcher, and a global source install at one full commit. The
// workflow tests of the CLI run again with `OPERATOR_INSTALLED_COMMAND`, so every command they
// send goes through the installed command, and readiness proves that it ran the installed release.
const fixture = await installFixture("installed");
let built: BuiltRelease | undefined;
const installs: Record<"jsr" | "source", { command: string; env: Record<string, string> }> = {
  jsr: { command: "", env: {} },
  source: { command: "", env: {} },
};

function current() {
  return built ?? expect.unreachable("beforeAll builds the release.");
}

beforeAll(async () => {
  const version = z
    .looseObject({ version: z.string() })
    .parse(await Bun.file(`${sourceRoot}/package.json`).json()).version;
  built = await fixture.release(version, "candidate");

  const jsr = fixture.device("jsr");
  const registry = await fixture.serve(jsr, built);
  try {
    await succeed(
      ["bun", "add", "-g", `${launcherPackage}@npm:${registryPackage}@${built.version}`],
      fixture.root,
      jsr.env,
    );
  } finally {
    await registry.stop();
  }
  const project = await fixture.checkout("jsr-registration");
  const direct = ["bun", `${jsr.global}/node_modules/${launcherPackage}/cli.js`];
  await succeed([...direct, "project", "register", "--json"], project, jsr.env);
  await succeed([...direct, "install", "launcher", "--json"], project, jsr.env);
  installs.jsr = { command: `${jsr.bin}/operator`, env: jsr.env };

  const source = fixture.device("source");
  const staging = `${fixture.root}/source-staging`;
  const commit = await fixture.sourceRepository(staging, built.version);
  await succeed(["bun", "add", "-g", `git+file://${staging}#${commit}`], fixture.root, source.env);
  await rm(staging, { recursive: true, force: true });
  installs.source = { command: `${source.bin}/operator`, env: source.env };
}, 300_000);

afterAll(async () => {
  await rm(fixture.root, { force: true, recursive: true });
});

/** Controlled hosts that answer only the model metadata requests, as in the CLI tests. */
async function hosts(tools: string) {
  await Bun.write(
    `${tools}/opencode`,
    `#!${process.execPath}\nconst dir=decodeURIComponent(process.argv[4].split("=")[1]);\nconsole.log(JSON.stringify({location:{directory:dir},data:[{providerID:"test",id:"reasoner",enabled:true,variants:[{id:"medium"},{id:"high"}]}]}));\n`,
    { createPath: true },
  );
  await Bun.write(
    `${tools}/claude`,
    `#!${process.execPath}
for await (const chunk of Bun.stdin.stream().pipeThrough(new TextDecoderStream())) {
 for (const line of chunk.trim().split("\\n")) {
  const message=JSON.parse(line);
  if(message.type === "control_request") console.log(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:message.request_id,response:{models:[{value:"precise-model",supportsEffort:true,supportedEffortLevels:["medium","high"]}],commands:[],agents:[]}}}));
 }
}
`,
  );
  await chmod(`${tools}/opencode`, 0o755);
  await chmod(`${tools}/claude`, 0o755);
}

const resultSchema = z.looseObject({ reason: z.string(), data: z.unknown().optional() });

for (const path of ["jsr", "source"] as const) {
  test(`${path}: registration, settings, profiles, and both hosts run through the installed command`, async () => {
    const release = current();
    const machine = fixture.device(`${path}-settings`);
    const tools = `${machine.base}/tools`;
    await hosts(tools);
    const env = { ...machine.env, PATH: `${tools}:${installs[path].env.PATH}` };
    const project = await fixture.checkout(`${path}-settings-project`);
    async function operator(args: string[]) {
      const result = await run([installs[path].command, ...args, "--json"], project, env);
      expect(result.exitCode, `${args.join(" ")}\n${result.stdout}${result.stderr}`).toBe(0);
      return resultSchema.parse(JSON.parse(result.stdout));
    }

    expect(await operator(["project", "register"])).toMatchObject({
      reason: "project_registered",
    });
    const version = versionSchema.parse(await operator(["--version"])).data;
    expect(version).toMatchObject({
      operatorVersion: release.version,
      artifactIdentity: path === "jsr" ? release.identity : null,
    });
    expect(await operator(["project", "show"])).toMatchObject({
      data: { repository: `example/${path}-settings-project` },
    });

    // The new release refuses legacy checkout-local state and leaves it exactly as it is.
    const legacy = await fixture.checkout(`${path}-legacy-project`);
    await Bun.write(`${legacy}/.operator/state.json`, "old\n", { createPath: true });
    const refused = await run(
      [installs[path].command, "project", "register", "--json"],
      legacy,
      env,
    );
    expect(refused.exitCode).toBe(3);
    expect(JSON.parse(refused.stdout)).toMatchObject({ reason: "legacy_project_state" });
    expect(await Bun.file(`${legacy}/.operator/state.json`).text()).toBe("old\n");

    const edits = [
      "--set",
      "superAgent.host=opencode",
      "--set",
      "superAgent.model=test/reasoner",
      "--set",
      "profiles.precise.host=claude-code",
      "--set",
      "profiles.precise.model=precise-model",
      "--set",
      "profiles.precise.reasoningEffort=high",
    ];
    const planned = z
      .object({ data: z.object({ planId: z.string() }) })
      .parse(await operator(["config", "plan", ...edits])).data;
    await operator(["config", "apply", ...edits, "--plan", planned.planId]);
    expect(await operator(["config", "show"])).toMatchObject({
      data: { config: { profiles: { precise: { host: "claude-code" } } } },
    });

    for (const host of ["opencode", "claude-code"])
      expect(await operator(["host", "models", "--host", host])).toMatchObject({
        reason: "host_models_read",
      });
    expect(await operator(["config", "resolve", "--role", "superAgent"])).toMatchObject({
      data: { host: "opencode", model: "test/reasoner" },
    });
    expect(await operator(["config", "resolve", "--profile", "precise"])).toMatchObject({
      data: { host: "claude-code", model: "precise-model", reasoningEffort: "high" },
    });
  }, 120_000);

  for (const workflow of [
    {
      name: "dispatch, report, and PR workflows on both hosts",
      file: "modules/operator-cli/run.delegated-run.test.ts",
      filter: "finish with no human stop",
    },
    {
      name: "non-Slack review operations on both hosts",
      file: "modules/operator-cli/run.reviews.test.ts",
      filter: "a manual request reviews the PR repository",
    },
  ])
    test(`${path}: ${workflow.name} run through the installed command`, async () => {
      // Each workflow test runs in its own child, so its fixture reads the installed command.
      const result = await run(
        [
          process.execPath,
          "test",
          "--isolate",
          "--timeout=120000",
          workflow.file,
          "-t",
          workflow.filter,
        ],
        sourceRoot,
        { OPERATOR_INSTALLED_COMMAND: installs[path].command },
      );
      const output = `${result.stdout}${result.stderr}`;
      expect(result.exitCode, output).toBe(0);
      expect(output).toMatch(/\b2 pass\b/);
      expect(output).toMatch(/\b0 fail\b/);
    }, 240_000);
}
