import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no recursive copy, real-path, link-reading, symlink, or directory removal API.
import { cp, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { z } from "zod";
import { Environment } from "../environment/main.ts";
import { ReleasePublish } from "../release-publish/main.ts";
import { OperatorRelease } from "./main.ts";
import { registryDependencies, registryManifest, startRegistryFake } from "./fake-registry.ts";
import { jsrSchema, releaseSchema, versionSchema } from "./test-schemas.ts";

// Real global installations from a local Git repository and a local registry that rewrites the
// package manifest the way JSR does. These are deterministic contract tests, not evidence about
// the live JSR service, and every Bun folder they touch is isolated under one temporary root.
const sourceRoot = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
// Bun reports real global folders, so the root is a real path too.
const root = `${realpathSync(Environment.read().TMPDIR ?? "/tmp")}/operator-global-${crypto.randomUUID()}`;
const tools = `${root}/tools`;
const registryPackage = "@jsr/fveracoechea__operator";
const launcherPackage = "@fveracoechea/operator";
let commit = "";
const releases: Array<{ version: string; identity: string; tarball: Uint8Array<ArrayBuffer> }> = [];
let dependencies: Record<string, string> = {};

/** Every Bun folder, settings root, and state root of one simulated device. */
function device(name: string) {
  const base = `${root}/${name}`;
  return {
    base,
    bin: `${base}/bun/bin`,
    global: `${base}/bun/install/global`,
    env: {
      HOME: `${base}/home`,
      XDG_CONFIG_HOME: `${base}/config`,
      XDG_STATE_HOME: `${base}/state`,
      BUN_INSTALL: `${base}/bun`,
      BUN_INSTALL_BIN: `${base}/bun/bin`,
      BUN_INSTALL_GLOBAL_DIR: `${base}/bun/install/global`,
      BUN_INSTALL_CACHE_DIR: `${base}/cache`,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      // A hook environment reaches Operator only through PATH: Bun's global bin folder and Bun.
      PATH: `${base}/bun/bin:${tools}`,
    },
  };
}

async function run(command: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawn(command, {
    cwd,
    env: Environment.child(env),
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

async function succeed(command: string[], cwd: string, env: Record<string, string>) {
  const result = await run(command, cwd, env);
  expect(result.exitCode, `${command.join(" ")}\n${result.stdout}${result.stderr}`).toBe(0);
  return result;
}

async function git(args: string[], cwd: string) {
  return succeed(
    [
      "git",
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=Test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    cwd,
    { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  );
}

async function checkout(name: string) {
  const path = `${root}/${name}`;
  await mkdir(path, { recursive: true });
  await git(["init", "-q"], path);
  await git(["remote", "add", "identity", `https://github.com/example/${name}.git`], path);
  return path;
}

/** One source copy committed at one full commit, with the given package version. */
async function sourceRepository(path: string, version: string) {
  for (const entry of [
    "cli.ts",
    "modules",
    "lib",
    "skills",
    "scripts",
    "docs/jsr",
    "tsconfig.json",
    "bun.lock",
  ])
    await cp(`${sourceRoot}/${entry}`, `${path}/${entry}`, { recursive: true });
  const manifest = z
    .looseObject({ version: z.string() })
    .parse(await Bun.file(`${sourceRoot}/package.json`).json());
  await Bun.write(`${path}/package.json`, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
  await git(["init", "-q", "-b", "main"], path);
  await git(["add", "-A"], path);
  await git(["commit", "-q", "-m", "release"], path);
  return (await git(["rev-parse", "HEAD"], path)).stdout.trim();
}

/** Builds one release and packs it with the manifest the registry would serve. */
async function release(version: string, index: number) {
  const repository = `${root}/release-source-${index}`;
  const built = await sourceRepository(repository, version);
  if (index === 0) commit = built;
  await symlink(`${sourceRoot}/node_modules`, `${repository}/node_modules`);
  const artifactRoot = `${root}/artifact-${index}`;
  const result = await OperatorRelease.build({
    sourceRoot: repository,
    artifactRoot,
    commit: built,
  });
  expect(result.status).toBe("built");
  const record = releaseSchema.parse(await Bun.file(`${artifactRoot}/release.json`).json());
  dependencies = registryDependencies(
    jsrSchema.parse(await Bun.file(`${artifactRoot}/jsr.json`).json()),
  );
  await Bun.write(
    `${artifactRoot}/package.json`,
    registryManifest({ packageName: registryPackage, version, dependencies }),
  );
  const packed = await ReleasePublish.pack({ artifactRoot, prefix: "package" });
  releases.push({ version, identity: record.artifactIdentity, tarball: packed.bytes });
}

async function versionReport(cwd: string, env: Record<string, string>) {
  const result = await succeed(["operator", "--version", "--json"], cwd, env);
  return { raw: result.stdout, data: versionSchema.parse(JSON.parse(result.stdout)).data };
}

/** The readiness blocker reasons for the global command, without the host or tool blockers. */
async function commandBlockers(cwd: string, env: Record<string, string>) {
  const result = await run(["operator", "ready", "--json"], cwd, env);
  const output = z
    .object({
      blockers: z.array(z.looseObject({ reason: z.string(), tool: z.string().optional() })),
    })
    .parse(JSON.parse(result.stdout));
  return output.blockers.filter((blocker) => blocker.tool === "operator").map((b) => b.reason);
}

/** An unrelated global package, installed through the same Bun global manifest and lock. */
async function installUnrelated(env: Record<string, string>, cwd: string) {
  const unrelated = `${root}/unrelated-${crypto.randomUUID()}`;
  await Bun.write(
    `${unrelated}/package.json`,
    JSON.stringify({ name: "unrelated-tool", version: "1.0.0", bin: { unrelated: "./tool.js" } }),
    { createPath: true },
  );
  await Bun.write(`${unrelated}/tool.js`, "#!/usr/bin/env bun\nconsole.log('unrelated');\n");
  await succeed(["bun", "add", "-g", `file:${unrelated}`], cwd, env);
}

beforeAll(async () => {
  await mkdir(tools, { recursive: true });
  await symlink(process.execPath, `${tools}/bun`);
  const gitPath = Bun.which("git", { PATH: Environment.read().PATH });
  expect(gitPath).not.toBeNull();
  await symlink(gitPath ?? "", `${tools}/git`);
  const base = z
    .looseObject({ version: z.string() })
    .parse(await Bun.file(`${sourceRoot}/package.json`).json()).version;
  await release(base, 0);
  await release(`${base}-update.1`, 1);
}, 300_000);

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

test("a full-commit source install runs through Bun's link after its source and cache disappear", async () => {
  const machine = device("source-device");
  const staging = `${root}/source-staging`;
  const staged = await sourceRepository(staging, releases[0]?.version ?? "");
  await succeed(["bun", "add", "-g", `git+file://${staging}#${staged}`], root, machine.env);
  const link = await readlink(`${machine.bin}/operator`);
  expect(link).toBe(`../install/global/node_modules/${launcherPackage}/cli.ts`);
  expect(link).not.toContain(staged);
  await rm(staging, { recursive: true, force: true });
  await rm(machine.env.BUN_INSTALL_CACHE_DIR, { recursive: true, force: true });

  const project = await checkout("source-project");
  const registered = await succeed(
    ["operator", "project", "register", "--json"],
    project,
    machine.env,
  );
  expect(JSON.parse(registered.stdout)).toMatchObject({ reason: "project_registered" });
  const before = await versionReport(project, machine.env);
  expect(before.data).toMatchObject({ operatorVersion: releases[0]?.version, commit: staged });
  expect(before.data.artifactIdentity).toBeNull();

  const lock = await Bun.file(`${machine.global}/bun.lock`).text();
  await installUnrelated(machine.env, root);
  expect(await Bun.file(`${machine.global}/bun.lock`).text()).not.toBe(lock);
  expect((await versionReport(project, machine.env)).raw).toBe(before.raw);
  const shown = await succeed(["operator", "project", "show", "--json"], project, machine.env);
  expect(JSON.parse(shown.stdout)).toMatchObject({
    data: { repository: "example/source-project" },
  });

  const refused = await run(["operator", "install", "launcher", "--json"], project, machine.env);
  expect(refused.exitCode).toBe(3);
  expect(JSON.parse(refused.stdout)).toMatchObject({ reason: "launcher_unsupported" });
  expect(await readlink(`${machine.bin}/operator`)).toBe(link);
  expect(await commandBlockers(project, machine.env)).toEqual([]);
}, 300_000);

test("a source install from a branch name reports that the device release is not pinned", async () => {
  const machine = device("branch-device");
  const staging = `${root}/branch-staging`;
  const staged = await sourceRepository(staging, releases[0]?.version ?? "");
  await succeed(["bun", "add", "-g", `git+file://${staging}#main`], root, machine.env);
  const project = await checkout("branch-project");
  await succeed(["operator", "project", "register", "--json"], project, machine.env);
  expect((await versionReport(project, machine.env)).data).toMatchObject({ commit: staged });
  const result = await run(["operator", "ready", "--json"], project, machine.env);
  expect(result.exitCode).toBe(3);
  expect(result.stdout).toContain(`names git+file://${staging}#main`);
  expect(await commandBlockers(project, machine.env)).toEqual(["installation_unpinned"]);
}, 300_000);

test("an exact JSR install gets one version-free launcher that follows updates after staging disappears", async () => {
  const machine = device("jsr-device");
  const [first, second] = releases;
  if (first === undefined || second === undefined) return expect(releases).toHaveLength(2);
  const installed = `${machine.global}/node_modules/${launcherPackage}`;
  const direct = ["bun", `${installed}/cli.js`];
  const project = await checkout("jsr-project");

  const registry = startRegistryFake({ packageName: registryPackage, ...first, dependencies });
  try {
    await Bun.write(
      `${machine.env.XDG_CONFIG_HOME}/.bunfig.toml`,
      `[install.scopes]\n"@jsr" = { url = "${registry.url}" }\n`,
      { createPath: true },
    );
    await succeed(
      ["bun", "add", "-g", `${launcherPackage}@npm:${registryPackage}@${first.version}`],
      root,
      machine.env,
    );
    expect(registry.requests).toContain(`/tarball/${first.version}.tgz`);
  } finally {
    await registry.stop();
  }
  await rm(machine.env.BUN_INSTALL_CACHE_DIR, { recursive: true, force: true });
  // The registry dropped the binary declaration, so Bun linked no command.
  expect(
    z.looseObject({}).parse(await Bun.file(`${installed}/package.json`).json()),
  ).not.toHaveProperty("bin");
  expect(await Bun.file(`${machine.bin}/operator`).exists()).toBe(false);
  expect(Bun.which("operator", { PATH: machine.env.PATH })).toBeNull();

  await succeed([...direct, "project", "register", "--json"], project, machine.env);
  const copy = `${root}/jsr-copy`;
  await cp(installed, copy, { recursive: true });
  await symlink(`${machine.global}/node_modules`, `${copy}/node_modules`);
  const elsewhere = await run(
    ["bun", `${copy}/cli.js`, "install", "launcher", "--json"],
    project,
    machine.env,
  );
  expect(elsewhere.exitCode).toBe(3);
  expect(JSON.parse(elsewhere.stdout)).toMatchObject({ reason: "launcher_unsupported" });
  expect(await Bun.file(`${machine.bin}/operator`).exists()).toBe(false);

  const written = await succeed([...direct, "install", "launcher", "--json"], project, machine.env);
  expect(JSON.parse(written.stdout)).toMatchObject({
    operation: "install_launcher",
    reason: "launcher_installed",
    data: { command: `${machine.bin}/operator`, runs: `${installed}/cli.js` },
  });
  const launcher = await Bun.file(`${machine.bin}/operator`).text();
  for (const transient of [first.version, registry.url, machine.env.BUN_INSTALL_CACHE_DIR, copy])
    expect(launcher).not.toContain(transient);

  const before = await versionReport(project, machine.env);
  expect(before.data).toMatchObject({
    operatorVersion: first.version,
    commit,
    artifactIdentity: first.identity,
  });
  const current = await succeed(
    ["operator", "install", "launcher", "--json"],
    project,
    machine.env,
  );
  expect(JSON.parse(current.stdout)).toMatchObject({ reason: "launcher_current" });
  expect(await commandBlockers(project, machine.env)).toEqual([]);

  const lock = await Bun.file(`${machine.global}/bun.lock`).text();
  await installUnrelated(machine.env, root);
  expect(await Bun.file(`${machine.global}/bun.lock`).text()).not.toBe(lock);
  expect((await versionReport(project, machine.env)).raw).toBe(before.raw);

  const update = startRegistryFake({ packageName: registryPackage, ...second, dependencies });
  try {
    await Bun.write(
      `${machine.env.XDG_CONFIG_HOME}/.bunfig.toml`,
      `[install.scopes]\n"@jsr" = { url = "${update.url}" }\n`,
    );
    await succeed(
      ["bun", "add", "-g", `${launcherPackage}@npm:${registryPackage}@${second.version}`],
      root,
      machine.env,
    );
  } finally {
    await update.stop();
  }
  await rm(machine.env.BUN_INSTALL_CACHE_DIR, { recursive: true, force: true });
  expect(await Bun.file(`${machine.bin}/operator`).text()).toBe(launcher);
  expect((await versionReport(project, machine.env)).data).toMatchObject({
    operatorVersion: second.version,
    artifactIdentity: second.identity,
  });
  const shown = await succeed(["operator", "project", "show", "--json"], project, machine.env);
  expect(JSON.parse(shown.stdout)).toMatchObject({ data: { repository: "example/jsr-project" } });

  expect(await commandBlockers(project, machine.env)).toEqual([]);
  await Bun.write(`${machine.bin}/operator`, "#!/bin/sh\necho personal\n");
  const conflict = await run([...direct, "install", "launcher", "--json"], project, machine.env);
  expect(conflict.exitCode).toBe(4);
  expect(JSON.parse(conflict.stdout)).toMatchObject({ reason: "launcher_conflict" });
  expect(await Bun.file(`${machine.bin}/operator`).text()).toBe("#!/bin/sh\necho personal\n");
}, 300_000);

/** The first fenced block of one language after a README heading, exactly as a person copies it. */
async function documented(heading: string, language: string) {
  const readme = await Bun.file(`${sourceRoot}/README.md`).text();
  const section = readme.slice(readme.indexOf(`\n${heading}\n`));
  const block = new RegExp(`\`\`\`${language}\\n([\\s\\S]*?)\`\`\``).exec(section)?.[1];
  expect(block).toBeDefined();
  return block ?? "";
}

test("the documented JSR and source installation blocks run as written", async () => {
  const [first] = releases;
  if (first === undefined) return expect(releases).toHaveLength(2);
  // The documented blocks also use the shell's own text tools.
  const shellPath = "/usr/bin:/bin";
  const jsr = device("documented-jsr");
  const registry = startRegistryFake({ packageName: registryPackage, ...first, dependencies });
  try {
    const scope = await documented("### JSR with Bun", "toml");
    expect(scope).toContain('"@jsr" = "https://npm.jsr.io"');
    await Bun.write(
      `${jsr.env.XDG_CONFIG_HOME}/.bunfig.toml`,
      scope.replace("https://npm.jsr.io", registry.url),
      { createPath: true },
    );
    const commands = await documented("### JSR with Bun", "sh");
    expect(commands).toContain("<exact-version>");
    const project = await checkout("documented-jsr-project");
    const result = await succeed(
      ["/bin/sh", "-e", "-c", commands.replaceAll("<exact-version>", first.version)],
      project,
      { ...jsr.env, PATH: `${jsr.env.PATH}:${shellPath}` },
    );
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "")).toMatchObject({
      data: { operatorVersion: first.version, commit, artifactIdentity: first.identity },
    });
  } finally {
    await registry.stop();
  }

  const source = device("documented-source");
  const staging = `${root}/documented-source-staging`;
  const staged = await sourceRepository(staging, first.version);
  const commands = await documented("### Repository source at a full commit", "sh");
  const published = "git+https://github.com/fveracoechea/operator.git#<full-commit>";
  expect(commands).toContain(published);
  const project = await checkout("documented-source-project");
  const result = await succeed(
    ["/bin/sh", "-e", "-c", commands.replace(published, `git+file://${staging}#${staged}`)],
    project,
    { ...source.env, PATH: `${source.env.PATH}:${shellPath}` },
  );
  expect(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "")).toMatchObject({
    data: { operatorVersion: first.version, commit: staged, artifactIdentity: null },
  });
}, 300_000);
