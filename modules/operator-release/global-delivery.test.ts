import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no recursive copy, link-reading, symlink, or directory removal API.
import { cp, readlink, rm, symlink } from "node:fs/promises";
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
import { startRegistryFake } from "./registry-fixture.ts";
import { versionSchema } from "./schemas-fixture.ts";

// Real global installations from a local Git repository and a local registry that rewrites the
// package manifest the way JSR does. These are deterministic contract tests, not evidence about
// the live JSR service, and every Bun folder they touch is isolated under one temporary root.
const fixture = await installFixture("global");
const { root, device, checkout, sourceRepository } = fixture;
let commit = "";
const releases: BuiltRelease[] = [];
let dependencies: Record<string, string> = {};

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
  const base = z
    .looseObject({ version: z.string() })
    .parse(await Bun.file(`${sourceRoot}/package.json`).json()).version;
  const first = await fixture.release(base, "first");
  ({ commit, dependencies } = first);
  releases.push(first, await fixture.release(`${base}-update.1`, "update"));
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
