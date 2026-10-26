import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Environment } from "../environment/main.ts";
import { Database } from "bun:sqlite";
import { registerTestDevice } from "../../scripts/device-fixture.ts";
// Bun has no recursive copy, symlink, or directory removal API.
import { chmod, cp, mkdir, rm, symlink } from "node:fs/promises";
import { OperatorRelease } from "./main.ts";
import { ReleasePublish } from "../release-publish/main.ts";
import { packageSchema, jsrSchema, releaseSchema, versionSchema } from "./test-schemas.ts";
import { z } from "zod";
import {
  registryDependencies,
  registryManifest,
  type RegistryFake,
  startRegistryFake,
} from "./fake-registry.ts";

const sourceRoot = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const root = `${Environment.read().TMPDIR ?? "/tmp"}/operator-delivery-${crypto.randomUUID()}`;
const sourceRepository = `${root}/source`;
const artifactRoot = `${root}/artifact`;
const registryProject = `${root}/registry-project`;
const sourceProject = `${root}/source-project`;
let registry: RegistryFake;
let version: string;
let commit: string;

async function run(command: string[], cwd: string, extra: Record<string, string> = {}) {
  const child = Bun.spawn(command, {
    cwd,
    env: {
      ...Environment.child(),
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

beforeAll(async () => {
  await registerTestDevice(root);
  await mkdir(sourceRepository, { recursive: true });
  for (const path of [
    "cli.ts",
    "modules",
    "lib",
    "skills",
    "scripts",
    "package.json",
    "tsconfig.json",
    "bun.lock",
  ]) {
    await cp(`${sourceRoot}/${path}`, `${sourceRepository}/${path}`, { recursive: true });
  }
  expect((await run(["git", "init", "-q", "-b", "main"], sourceRepository)).exitCode).toBe(0);
  expect((await run(["git", "add", "-A"], sourceRepository)).exitCode).toBe(0);
  expect(
    (
      await run(
        [
          "git",
          "-c",
          "user.email=t@example.com",
          "-c",
          "user.name=Test",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-q",
          "-m",
          "release",
        ],
        sourceRepository,
      )
    ).exitCode,
  ).toBe(0);
  commit = (await run(["git", "rev-parse", "HEAD"], sourceRepository)).stdout.trim();
  expect((await OperatorRelease.build({ sourceRoot, artifactRoot, commit })).status).toBe("built");
  version = releaseSchema.parse(await Bun.file(`${artifactRoot}/release.json`).json()).version;
  await mkdir(sourceProject, { recursive: true });
  await Bun.write(`${sourceProject}/package.json`, '{"name":"source-consumer","private":true}\n');
  const installed = await run(
    [process.execPath, "add", `git+file://${sourceRepository}#${commit}`],
    sourceProject,
  );
  expect(installed.stderr, installed.stdout).not.toContain("error:");
  expect(installed.exitCode).toBe(0);

  const registryRoot = `${root}/registry-artifact`;
  await cp(artifactRoot, registryRoot, { recursive: true });
  const dependencies = registryDependencies(
    jsrSchema.parse(await Bun.file(`${artifactRoot}/jsr.json`).json()),
  );
  await Bun.write(
    `${registryRoot}/package.json`,
    registryManifest({ packageName: "@jsr/fveracoechea__operator", version, dependencies }),
  );
  const packed = await ReleasePublish.pack({ artifactRoot: registryRoot, prefix: "package" });
  registry = startRegistryFake({
    packageName: "@jsr/fveracoechea__operator",
    version,
    tarball: packed.bytes,
    dependencies,
  });
  await Bun.write(
    `${registryProject}/bunfig.toml`,
    `[install.scopes]\n"@jsr" = { url = "${registry.url}" }\n`,
    { createPath: true },
  );
  await Bun.write(
    `${registryProject}/package.json`,
    JSON.stringify({
      name: "registry-consumer",
      private: true,
      dependencies: { "@fveracoechea/operator": `npm:@jsr/fveracoechea__operator@${version}` },
    }),
  );
  const fetched = await run([process.execPath, "install"], registryProject, {
    BUN_INSTALL_CACHE_DIR: `${root}/registry-cache`,
  });
  expect(fetched.stderr, fetched.stdout).not.toContain("error:");
  expect(fetched.exitCode).toBe(0);
}, 300_000);

afterAll(async () => {
  await registry?.stop();
  await rm(root, { force: true, recursive: true });
});

describe("real source-package delivery", () => {
  test("installs an executable at a fixed Git commit without an install-time build", async () => {
    expect(await Bun.file(`${sourceProject}/node_modules/.bin/operator`).exists()).toBe(true);
    const result = await run(
      [`${sourceProject}/node_modules/.bin/operator`, "--version", "--json"],
      sourceProject,
    );
    expect(result.exitCode).toBe(0);
    expect(versionSchema.parse(JSON.parse(result.stdout)).data.operatorVersion).toBe(version);
    expect(
      await Bun.file(`${sourceProject}/node_modules/@fveracoechea/operator/cli.js`).exists(),
    ).toBe(false);
    const untrusted = await run([process.execPath, "pm", "untrusted"], sourceProject);
    expect(untrusted.stdout).toContain("@fveracoechea/operator");
  });
});

describe("real registry-artifact delivery", () => {
  test("runs the exported CLI after the registry drops binary and engine declarations", async () => {
    const manifest = packageSchema.parse(
      await Bun.file(`${registryProject}/node_modules/@fveracoechea/operator/package.json`).json(),
    );
    expect(manifest.name).toBe("@jsr/fveracoechea__operator");
    expect(manifest.version).toBe(version);
    expect(manifest.bin).toBeUndefined();
    expect(manifest.engines).toBeUndefined();
    const result = await run(
      [
        process.execPath,
        "-e",
        'const { main } = await import("@fveracoechea/operator/cli"); await main(["--version", "--json"]);',
      ],
      registryProject,
    );
    expect(result.exitCode).toBe(0);
    const output = versionSchema.parse(JSON.parse(result.stdout));
    expect(output.data).toMatchObject({ operatorVersion: version, commit });
    expect(output.data).not.toHaveProperty("selection");
    expect(registry.requests).toContain(`/tarball/${version}.tgz`);
  });

  test("preserves exact package contents and lock data through a frozen reinstall", async () => {
    const before = await Bun.file(`${registryProject}/bun.lock`).text();
    expect(
      (await run([process.execPath, "install", "--frozen-lockfile"], registryProject)).exitCode,
    ).toBe(0);
    expect(await Bun.file(`${registryProject}/bun.lock`).text()).toBe(before);
    const installed = `${registryProject}/node_modules/@fveracoechea/operator`;
    expect(await Bun.file(`${installed}/skills/deep-modules/module-shape.md`).text()).toBe(
      await Bun.file(`${sourceRoot}/skills/deep-modules/module-shape.md`).text(),
    );
    expect(await Bun.file(`${installed}/release.json`).text()).toBe(
      await Bun.file(`${artifactRoot}/release.json`).text(),
    );
  });

  test("serves public declarations that a consumer can typecheck", async () => {
    await Bun.write(
      `${registryProject}/consumer.ts`,
      'import { main } from "@fveracoechea/operator/cli";\nexport const run: (args: string[]) => Promise<void> = main;\n',
    );
    await Bun.write(
      `${registryProject}/tsconfig.json`,
      JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          target: "ESNext",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          typeRoots: [`${sourceRoot}/node_modules/@types`],
          types: ["bun"],
        },
        files: ["consumer.ts"],
      }),
    );
    const result = await run(
      [
        process.execPath,
        `${sourceRoot}/node_modules/typescript/bin/tsc`,
        "-p",
        `${registryProject}/tsconfig.json`,
      ],
      sourceRoot,
    );
    expect(`${result.stdout}${result.stderr}`).toBe("");
    expect(result.exitCode).toBe(0);
  }, 300_000);
});

test("the built runtime refuses unsupported Bun before any command handler", async () => {
  const rejected = `${root}/unsupported`;
  await cp(artifactRoot, rejected, { recursive: true });
  await symlink(`${sourceRoot}/node_modules`, `${rejected}/node_modules`);
  const release = releaseSchema.parse(await Bun.file(`${rejected}/release.json`).json());
  await Bun.write(
    `${rejected}/release.json`,
    JSON.stringify({ ...release, supportedBun: ">=999.0.0" }),
  );
  for (const args of [["--help"], ["--version"], ["setup", "apply"]]) {
    const result = await run([process.execPath, `${rejected}/cli.js`, ...args, "--json"], root);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      operation: "startup",
      reason: "unsupported_bun",
    });
    expect(result.stderr).toContain("Bun >=999.0.0 is required");
  }
  expect(await Bun.file(`${root}/.operator/config.json`).exists()).toBe(false);
});

test("device settings examples work through installed source and registry commands", async () => {
  const invocations = [
    {
      name: "source",
      cwd: sourceProject,
      command: [`${sourceProject}/node_modules/.bin/operator`],
    },
    {
      name: "registry",
      cwd: registryProject,
      command: [
        process.execPath,
        "-e",
        'const { main } = await import("@fveracoechea/operator/cli"); await main(Bun.argv.slice(1));',
        "--",
      ],
    },
  ];
  for (const invocation of invocations) {
    const isolated = {
      XDG_CONFIG_HOME: `${root}/${invocation.name}-config`,
      XDG_STATE_HOME: `${root}/${invocation.name}-state`,
    };
    await registerTestDevice(root, isolated.XDG_STATE_HOME);
    const show = await run(
      [...invocation.command, "config", "show", "--json"],
      invocation.cwd,
      isolated,
    );
    expect(show.exitCode).toBe(0);
    expect(JSON.parse(show.stdout)).toMatchObject({
      reason: "settings_read",
      data: { exists: false },
    });
    const edit = ["--set", "superAgent.host=opencode"];
    const plan = await run(
      [...invocation.command, "config", "plan", ...edit, "--json"],
      invocation.cwd,
      isolated,
    );
    expect(plan.exitCode).toBe(0);
    const id = z.object({ data: z.object({ planId: z.string() }) }).parse(JSON.parse(plan.stdout))
      .data.planId;
    const applied = await run(
      [...invocation.command, "config", "apply", ...edit, "--plan", id, "--json"],
      invocation.cwd,
      isolated,
    );
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({ reason: "settings_applied" });
    const recovered = await run(
      [...invocation.command, "config", "recover", "--json"],
      invocation.cwd,
      isolated,
    );
    expect(recovered.exitCode).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({ data: { state: "complete" } });
  }
}, 300_000);

test("both host profiles resolve through installed source and registry commands", async () => {
  const tools = `${root}/profile-tools`;
  await Bun.write(
    `${tools}/opencode`,
    `#!${process.execPath}
console.log(JSON.stringify({location:{directory:process.cwd()},data:[{providerID:"test",id:"reasoner",enabled:true,variants:[{id:"medium"},{id:"high"}]}]}));
`,
    { createPath: true },
  );
  await Bun.write(
    `${tools}/claude`,
    `#!${process.execPath}
for await(const chunk of Bun.stdin.stream().pipeThrough(new TextDecoderStream())) {
 for(const line of chunk.trim().split("\\n")) {
  const message=JSON.parse(line);
  if(message.type === "control_request") console.log(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:message.request_id,response:{models:[{value:"host-model",supportsEffort:true,supportedEffortLevels:["medium","high"]}],commands:[],agents:[]}}}));
 }
}
`,
    { createPath: true },
  );
  for (const tool of ["opencode", "claude"]) await chmod(`${tools}/${tool}`, 0o755);
  for (const invocation of [
    {
      name: "source",
      cwd: sourceProject,
      command: [`${sourceProject}/node_modules/.bin/operator`],
    },
    {
      name: "registry",
      cwd: registryProject,
      command: [
        process.execPath,
        "-e",
        'const { main } = await import("@fveracoechea/operator/cli"); await main(Bun.argv.slice(1));',
        "--",
      ],
    },
  ]) {
    const environment = {
      XDG_CONFIG_HOME: `${root}/${invocation.name}-profiles-config`,
      XDG_STATE_HOME: `${root}/${invocation.name}-profiles-state`,
      PATH: `${tools}:${Environment.read().PATH}`,
    };
    await registerTestDevice(root, environment.XDG_STATE_HOME);
    const edits = [
      "--set",
      "superAgent.host=opencode",
      "--set",
      "superAgent.model=test/reasoner",
      "--set",
      "profiles.investigation.reasoningEffort=high",
    ];
    const planned = await run(
      [...invocation.command, "config", "plan", ...edits, "--json"],
      invocation.cwd,
      environment,
    );
    expect(planned.exitCode, planned.stderr).toBe(0);
    const planId = z
      .object({ data: z.object({ planId: z.string() }) })
      .parse(JSON.parse(planned.stdout)).data.planId;
    expect(
      (
        await run(
          [...invocation.command, "config", "apply", ...edits, "--plan", planId, "--json"],
          invocation.cwd,
          environment,
        )
      ).exitCode,
    ).toBe(0);
    const selected = await run(
      [...invocation.command, "config", "resolve", "--profile", "investigation", "--json"],
      invocation.cwd,
      environment,
    );
    expect(selected.exitCode, selected.stderr).toBe(0);
    expect(JSON.parse(selected.stdout)).toMatchObject({
      reason: "launch_resolved",
      data: {
        model: "test/reasoner",
        reasoningEffort: "high",
        command: { tool: "opencode", args: ["mini", "--model", "test/reasoner#high"] },
      },
    });
    const claude = await run(
      [
        ...invocation.command,
        "config",
        "resolve",
        "--host",
        "claude-code",
        "--model",
        "host-model",
        "--json",
      ],
      invocation.cwd,
      environment,
    );
    expect(claude.exitCode, claude.stderr).toBe(0);
    expect(JSON.parse(claude.stdout)).toMatchObject({
      data: { command: { tool: "claude", args: ["--model", "host-model", "--effort", "medium"] } },
    });
  }
}, 300_000);

test("project registration uses installed migrations and ignores unrelated global lock changes", async () => {
  const invocations = [
    {
      name: "source",
      cwd: sourceProject,
      command: [`${sourceProject}/node_modules/.bin/operator`],
    },
    {
      name: "registry",
      cwd: registryProject,
      command: [
        process.execPath,
        "-e",
        'const { main } = await import("@fveracoechea/operator/cli"); await main(Bun.argv.slice(1));',
        "--",
      ],
    },
  ];
  for (const invocation of invocations) {
    expect((await run(["git", "init", "-q"], invocation.cwd)).exitCode).toBe(0);
    expect(
      (
        await run(
          ["git", "remote", "add", "identity", "https://github.com/Example/Installed.git"],
          invocation.cwd,
        )
      ).exitCode,
    ).toBe(0);
    const isolated = { XDG_STATE_HOME: `${root}/${invocation.name}-registration` };
    const registered = await run(
      [...invocation.command, "project", "register", "--json"],
      invocation.cwd,
      isolated,
    );
    expect(registered.stderr).toBe("");
    expect(registered.exitCode).toBe(0);
    expect(JSON.parse(registered.stdout)).toMatchObject({
      reason: "project_registered",
      data: { repository: "example/installed" },
    });
    const before = await run(
      [...invocation.command, "--version", "--json"],
      invocation.cwd,
      isolated,
    );
    await Bun.write(
      `${root}/home/.bun/install/global/bun.lock`,
      "unrelated global package install\n",
      { createPath: true },
    );
    const shown = await run(
      [...invocation.command, "project", "show", "--json"],
      invocation.cwd,
      isolated,
    );
    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      reason: "project_resolved",
      data: { repository: "example/installed" },
    });
    // This isolated fixture represents a device last opened by the first-history release.
    {
      using database = new Database(`${isolated.XDG_STATE_HOME}/operator/operator.sqlite`);
      database.exec(
        "DROP TABLE assignments; DROP TABLE sources; DROP TABLE project_removals; DELETE FROM __drizzle_migrations WHERE created_at > (SELECT MIN(created_at) FROM __drizzle_migrations)",
      );
    }
    const migrated = await run(
      [...invocation.command, "--version", "--json"],
      invocation.cwd,
      isolated,
    );
    expect(migrated.exitCode, migrated.stderr).toBe(0);
    expect(migrated.stdout).toBe(before.stdout);
    const migrationBackups = await Array.fromAsync(
      new Bun.Glob("*/operator.sqlite").scan({
        cwd: `${isolated.XDG_STATE_HOME}/operator/backups`,
      }),
    );
    expect(migrationBackups).toHaveLength(1);
    using migrationBackup = new Database(
      `${isolated.XDG_STATE_HOME}/operator/backups/${migrationBackups[0]}`,
      { readonly: true },
    );
    expect(migrationBackup.query("PRAGMA integrity_check").values()).toEqual([["ok"]]);
    expect(migrationBackup.query("SELECT * FROM __drizzle_migrations").all()).toHaveLength(1);
    const plan = `${root}/${invocation.name}-assignments.json`;
    await Bun.write(
      plan,
      JSON.stringify({
        trackerKey: "github:example/installed#1",
        assignments: [
          {
            key: "read",
            trackerKey: "github:example/installed#2",
            instructions: "Read and report. Ask the person when authority is unclear.",
            completion: "report",
            resources: "pane",
            dependencies: [],
          },
        ],
      }),
    );
    const source = await run(
      [...invocation.command, "source", "register", "--file", plan, "--json"],
      invocation.cwd,
      isolated,
    );
    expect(source.exitCode, source.stderr).toBe(0);
    const sourceId = z.object({ data: z.object({ id: z.uuid() }) }).parse(JSON.parse(source.stdout))
      .data.id;
    const sourceRead = await run(
      [...invocation.command, "source", "show", "--source", sourceId, "--json"],
      invocation.cwd,
      isolated,
    );
    expect(sourceRead.exitCode, sourceRead.stderr).toBe(0);
    expect(JSON.parse(sourceRead.stdout)).toMatchObject({
      data: { id: sourceId, plan: { trackerKey: "github:example/installed#1" } },
    });
    const next = await run(
      [...invocation.command, "next", "--source", sourceId, "--json"],
      invocation.cwd,
      isolated,
    );
    expect(next.exitCode, next.stderr).toBe(0);
    expect(JSON.parse(next.stdout)).toMatchObject({
      reason: "next_actions_read",
      data: {
        sources: [
          {
            id: sourceId,
            actions: [{ action: "ready_assignment", assignment: "read" }],
            waits: [],
          },
        ],
      },
    });
    const after = await run(
      [...invocation.command, "--version", "--json"],
      invocation.cwd,
      isolated,
    );
    expect(after.stdout).toBe(before.stdout);
    expect(await Bun.file(`${invocation.cwd}/.operator/config.json`).exists()).toBe(false);
  }
}, 300_000);

test("installed source and registry CLIs list, move, and remove project history without changing checkouts", async () => {
  for (const delivery of [
    { name: "source", command: [`${sourceProject}/node_modules/.bin/operator`] },
    {
      name: "registry",
      command: [process.execPath, `${registryProject}/node_modules/@fveracoechea/operator/cli.js`],
    },
  ]) {
    const old = `${root}/${delivery.name}-management-old`;
    const alternate = `${root}/${delivery.name}-management-new`;
    const environment = { XDG_STATE_HOME: `${root}/${delivery.name}-management-state` };
    for (const cwd of [old, alternate]) {
      await mkdir(cwd);
      expect((await run(["git", "init", "-q"], cwd)).exitCode).toBe(0);
      expect(
        (
          await run(
            ["git", "remote", "add", "identity", "https://github.com/example/manage.git"],
            cwd,
          )
        ).exitCode,
      ).toBe(0);
      await Bun.write(`${cwd}/keep.txt`, "unlanded work");
    }
    expect(
      (await run([...delivery.command, "project", "register", "--json"], old, environment))
        .exitCode,
    ).toBe(0);
    const plan = `${root}/${delivery.name}-management-plan.json`;
    await Bun.write(plan, JSON.stringify({ trackerKey: "empty", assignments: [] }));
    expect(
      (
        await run(
          [...delivery.command, "source", "register", "--file", plan, "--json"],
          old,
          environment,
        )
      ).exitCode,
    ).toBe(0);
    const listed = await run([...delivery.command, "project", "list", "--json"], root, environment);
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      data: {
        projects: [
          {
            repository: "example/manage",
            checkout: old,
            openSources: 0,
            controller: { status: "available" },
          },
        ],
      },
    });
    const moved = await run(
      [...delivery.command, "project", "move", "--json"],
      alternate,
      environment,
    );
    expect(moved.exitCode, moved.stderr).toBe(0);
    expect(JSON.parse(moved.stdout)).toMatchObject({ data: { checkout: alternate } });
    const removed = await run(
      [...delivery.command, "project", "remove", "example/manage", "--person-instructed", "--json"],
      root,
      environment,
    );
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({ reason: "project_removed" });
    const empty = await run([...delivery.command, "project", "list", "--json"], root, environment);
    expect(JSON.parse(empty.stdout)).toMatchObject({ data: { projects: [], pendingRemovals: [] } });
    for (const cwd of [old, alternate])
      expect(await Bun.file(`${cwd}/keep.txt`).text()).toBe("unlanded work");
  }
}, 300_000);

test("a failed shipped migration cannot publish a partial first database", async () => {
  const damaged = `${root}/failed-registration-artifact`;
  await cp(artifactRoot, damaged, { recursive: true });
  await symlink(`${sourceRoot}/node_modules`, `${damaged}/node_modules`);
  const migration = `${damaged}/modules/device-state/migrations/0000_register_projects.sql`;
  await Bun.write(
    migration,
    `${await Bun.file(migration).text()}\n--> statement-breakpoint\nSELECT * FROM deliberately_missing_table;\n`,
  );
  const checkout = `${root}/failed-registration-checkout`;
  await mkdir(checkout);
  expect((await run(["git", "init", "-q"], checkout)).exitCode).toBe(0);
  expect(
    (
      await run(
        ["git", "remote", "add", "identity", "https://github.com/example/failed.git"],
        checkout,
      )
    ).exitCode,
  ).toBe(0);
  const state = `${root}/failed-registration-state`;
  const result = await run(
    [process.execPath, `${damaged}/cli.js`, "project", "register", "--json"],
    checkout,
    { XDG_STATE_HOME: state },
  );
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ reason: "project_defect" });
  expect(await Bun.file(`${state}/operator/operator.sqlite`).exists()).toBe(false);
  expect(
    await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: `${state}/operator`, dot: true })),
  ).toEqual([]);
  expect(
    (await run(["git", "status", "--porcelain=v1", "--untracked-files=all"], checkout)).stdout,
  ).toBe("");
}, 300_000);

test("an installed CLI finds its release and migrations under escaped directory names", async () => {
  const installed = `${root}/installed copy with spaces #release`;
  await cp(`${registryProject}/node_modules/@fveracoechea/operator`, installed, {
    recursive: true,
  });
  await symlink(`${registryProject}/node_modules`, `${installed}/node_modules`);
  const checkout = `${root}/escaped-install-checkout`;
  await mkdir(checkout);
  expect((await run(["git", "init", "-q"], checkout)).exitCode).toBe(0);
  expect(
    (
      await run(
        ["git", "remote", "add", "identity", "https://github.com/example/escaped.git"],
        checkout,
      )
    ).exitCode,
  ).toBe(0);
  const isolated = { XDG_STATE_HOME: `${root}/escaped-install-state` };
  const result = await run(
    [process.execPath, `${installed}/cli.js`, "project", "register", "--json"],
    checkout,
    isolated,
  );
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    reason: "project_registered",
    data: { repository: "example/escaped" },
  });
  const shown = await run(
    [process.execPath, `${installed}/cli.js`, "project", "show", "--json"],
    checkout,
    isolated,
  );
  expect(shown.exitCode).toBe(0);
  expect(JSON.parse(shown.stdout)).toMatchObject({ reason: "project_resolved" });
  const reported = await run(
    [process.execPath, `${installed}/cli.js`, "--version", "--json"],
    checkout,
    isolated,
  );
  expect(JSON.parse(reported.stdout)).toMatchObject({ data: { operatorVersion: version, commit } });
}, 300_000);

test("installed source and registry CLIs copy complete skills to both hosts and safely update them", async () => {
  for (const delivery of [
    {
      name: "source",
      installed: `${sourceProject}/node_modules/@fveracoechea/operator`,
      entry: "cli.ts",
    },
    {
      name: "registry",
      installed: `${registryProject}/node_modules/@fveracoechea/operator`,
      entry: "cli.js",
    },
  ]) {
    const installed = `${root}/${delivery.name} installed skills #release`;
    await cp(delivery.installed, installed, { recursive: true });
    await symlink(`${sourceRoot}/node_modules`, `${installed}/node_modules`);
    const checkout = `${root}/${delivery.name}-skills-checkout`;
    await mkdir(checkout);
    const environment = {
      HOME: `${root}/${delivery.name}-skills-home`,
      XDG_CONFIG_HOME: `${root}/${delivery.name}-skills-config`,
      XDG_STATE_HOME: `${root}/${delivery.name}-skills-state`,
    };
    expect((await run(["git", "init", "-q"], checkout, environment)).exitCode).toBe(0);
    expect(
      (
        await run(
          [
            "git",
            "remote",
            "add",
            "identity",
            `https://github.com/example/${delivery.name}-skills.git`,
          ],
          checkout,
          environment,
        )
      ).exitCode,
    ).toBe(0);
    const command = [process.execPath, `${installed}/${delivery.entry}`];
    expect(
      (await run([...command, "project", "register", "--json"], checkout, environment)).exitCode,
    ).toBe(0);
    const database = await Bun.file(
      `${environment.XDG_STATE_HOME}/operator/operator.sqlite`,
    ).bytes();
    for (const flags of [
      ["--opencode"],
      ["--claude"],
      ["--opencode", "--claude"],
      ["--opencode", "--claude", "--check"],
    ]) {
      const result = await run([...command, "install", ...flags, "--json"], checkout, environment);
      expect(result.exitCode, result.stderr).toBe(0);
    }
    const hosts = [
      `${environment.HOME}/.claude/skills`,
      `${environment.XDG_CONFIG_HOME}/opencode/skills`,
    ];
    for (const host of hosts) {
      for await (const file of new Bun.Glob("*/SKILL.md").scan({ cwd: `${installed}/skills` })) {
        const name = file.split("/")[0];
        for await (const asset of new Bun.Glob("**/*").scan({
          cwd: `${installed}/skills/${name}`,
          dot: true,
        }))
          expect(await Bun.file(`${host}/${name}/${asset}`).bytes()).toEqual(
            await Bun.file(`${installed}/skills/${name}/${asset}`).bytes(),
          );
      }
    }
    const tools = `${root}/${delivery.name}-readiness-tools`;
    for (const tool of ["gh", "herdr", "opencode", "claude", "git", "bun"]) {
      const script =
        tool === "gh"
          ? `if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(["auth","status","--hostname","github.com"])) process.exit(99);`
          : tool === "git"
            ? `const a=process.argv.slice(2); if(a[0]==="clone") { for(const name of ["code-review","bun","super-agent"]) await Bun.write(a.at(-1)+"/skills/"+name+"/SKILL.md","---\\nname: "+name+"\\n---\\n",{createPath:true}); } else console.log("${"a".repeat(40)}");`
            : tool === "bun"
              ? `await Bun.write(${JSON.stringify(`${environment.HOME}/.agents/skills/code-review/SKILL.md`)},"independent upstream skill\\n",{createPath:true}); await Bun.write(${JSON.stringify(`${environment.HOME}/.claude/skills/code-review/SKILL.md`)},"independent upstream skill\\n",{createPath:true}); console.log(JSON.stringify([{name:"code-review",status:"installed"}]));`
              : "process.exit(99);";
      await Bun.write(`${tools}/${tool}`, `#!${process.execPath}\n${script}`, { createPath: true });
      await chmod(`${tools}/${tool}`, 0o755);
    }
    const controlled = { ...environment, PATH: tools };
    const upstream = await run(
      [...command, "install", "matt", "--opencode", "--claude", "--json"],
      checkout,
      controlled,
    );
    expect(upstream.exitCode, upstream.stderr).toBe(0);
    expect(JSON.parse(upstream.stdout)).toMatchObject({
      reason: "upstream_installed",
      data: { installerVersion: "1.7.4", commit: "a".repeat(40), skills: ["code-review"] },
    });
    for (const host of ["opencode", "claude-code"]) {
      const edit = ["--set", `superAgent.host=${host}`];
      const plan = await run(
        [...command, "config", "plan", ...edit, "--json"],
        checkout,
        controlled,
      );
      expect(plan.exitCode, plan.stderr).toBe(0);
      const planId = z
        .object({ data: z.object({ planId: z.string() }) })
        .parse(JSON.parse(plan.stdout)).data.planId;
      expect(
        (
          await run(
            [...command, "config", "apply", ...edit, "--plan", planId, "--json"],
            checkout,
            controlled,
          )
        ).exitCode,
      ).toBe(0);
      const ready = await run([...command, "ready", "--json"], checkout, controlled);
      expect(ready.exitCode, ready.stderr).toBe(0);
      expect(JSON.parse(ready.stdout)).toMatchObject({
        reason: "ready",
        blockers: [],
        data: { staticOnly: true },
      });
    }
    await Bun.write(`${installed}/skills/deep-modules/module-shape.md`, "new release asset\n");
    const updated = await run(
      [...command, "install", "--opencode", "--claude", "--json"],
      checkout,
      environment,
    );
    expect(updated.exitCode, updated.stderr).toBe(0);
    for (const host of hosts)
      expect(await Bun.file(`${host}/deep-modules/module-shape.md`).text()).toBe(
        "new release asset\n",
      );
    await Bun.write(`${hosts[0]}/deep-modules/module-shape.md`, "personal edit\n");
    const conflict = await run(
      [...command, "install", "--opencode", "--claude", "--json"],
      checkout,
      environment,
    );
    expect(conflict.exitCode).toBe(4);
    expect(await Bun.file(`${hosts[0]}/deep-modules/module-shape.md`).text()).toBe(
      "personal edit\n",
    );
    expect(
      await Bun.file(`${environment.XDG_STATE_HOME}/operator/operator.sqlite`).bytes(),
    ).toEqual(database);
    expect(
      (
        await run(
          ["git", "status", "--porcelain=v1", "--untracked-files=all"],
          checkout,
          environment,
        )
      ).stdout,
    ).toBe("");
  }
}, 300_000);
