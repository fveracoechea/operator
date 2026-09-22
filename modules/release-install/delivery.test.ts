import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { OperatorRelease } from "../operator-release/main.ts";
import { ReleasePublish } from "../release-publish/main.ts";
import { registryManifest, type RegistryFake, startRegistryFake } from "./fake-registry.ts";
import { ReleaseInstall } from "./main.ts";

/**
 * Both delivery paths, driven end to end against a real Bun install.
 * The GitHub source path installs the repository at one exact commit from a real local Git
 * repository. The registry path installs the built artifact from a local registry that rewrites
 * the package manifest the way JSR does. No network call leaves this machine.
 */

const sourceRoot = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const roots: string[] = [];
const fakes: RegistryFake[] = [];

const SOURCE_FILES = [
  "cli.ts",
  "modules",
  "skills",
  "scripts",
  "package.json",
  "tsconfig.json",
  "bun.lock",
];

let root = "";
let sourceRepository = "";
let sourceCommit = "";
let artifactRoot = "";
let version = "";

async function run(command: string[], cwd: string, env: Record<string, string> = {}) {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, ...env },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

beforeAll(async () => {
  root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-delivery-${crypto.randomUUID()}`;
  roots.push(root);
  sourceRepository = `${root}/source`;
  artifactRoot = `${root}/artifact`;

  await Bun.$`mkdir -p ${sourceRepository}`.quiet();
  for (const path of SOURCE_FILES) {
    await Bun.$`cp -R ${sourceRoot}/${path} ${sourceRepository}/${path}`.quiet();
  }
  await Bun.$`git init -q -b main ${sourceRepository}`.quiet();
  await Bun.$`git -C ${sourceRepository} add -A`.quiet();
  await Bun.$`git -C ${sourceRepository} -c user.email=t@example.com -c user.name=Test commit -q -m release`.quiet();
  sourceCommit = (await Bun.$`git -C ${sourceRepository} rev-parse HEAD`.quiet()).stdout
    .toString()
    .trim();

  await OperatorRelease.build({ sourceRoot, artifactRoot, commit: sourceCommit });
  version = (await Bun.file(`${artifactRoot}/release.json`).json()).version;
}, 300_000);

afterAll(async () => {
  for (const fake of fakes.splice(0)) {
    fake.stop();
  }
  await Promise.all(roots.splice(0).map((one) => rm(one, { force: true, recursive: true })));
});

describe("the GitHub source delivery path", () => {
  let consumer = "";

  beforeAll(async () => {
    consumer = `${root}/github-consumer`;
    await Bun.$`mkdir -p ${consumer}`.quiet();
    await Bun.write(
      `${consumer}/package.json`,
      `${JSON.stringify({ name: "app", private: true })}\n`,
    );
    const installed = await run(
      ["bun", "add", `git+file://${sourceRepository}#${sourceCommit}`],
      consumer,
    );
    expect(installed.exitCode).toBe(0);
  }, 300_000);

  test("installs the command with no install-time build and no lifecycle trust", async () => {
    const untrusted = await run(["bun", "pm", "untrusted"], consumer);

    expect(await Bun.file(`${consumer}/node_modules/.bin/operator`).exists()).toBe(true);
    expect(untrusted.stdout).toContain("@fveracoechea/operator");
  });

  test("carries the complete owned-skill assets and the nested files beside them", async () => {
    const installed = `${consumer}/node_modules/@fveracoechea/operator`;

    expect(await Bun.file(`${installed}/skills/operator/SKILL.md`).exists()).toBe(true);
    expect(await Bun.file(`${installed}/skills/operator/COORDINATION.md`).exists()).toBe(true);
    expect(await Bun.file(`${installed}/skills/no-slop/SKILL.md`).exists()).toBe(true);
  });

  test("reports the release version for a person and for an agent", async () => {
    const readable = await run(["./node_modules/.bin/operator", "--version"], consumer);
    const machine = await run(["./node_modules/.bin/operator", "--version", "--json"], consumer);

    expect(readable.exitCode).toBe(0);
    expect(readable.stdout.trim()).toBe(`operator ${version}`);
    expect(JSON.parse(machine.stdout).data).toMatchObject({ operatorVersion: version });
  });

  test("propagates arguments and the exit meaning of a refusal", async () => {
    const refused = await run(["./node_modules/.bin/operator", "wibble", "--json"], consumer);

    expect(refused.exitCode).toBe(2);
    expect(JSON.parse(refused.stdout).reason).toBe("invalid_arguments");
    expect(refused.stderr).toContain("operator update plan");
  });

  test("acts on the working directory it was run from", async () => {
    const project = `${root}/github-project`;
    await Bun.$`mkdir -p ${project}`.quiet();
    await Bun.$`git init -q ${project}`.quiet();

    const planned = await run(
      [`${consumer}/node_modules/.bin/operator`, "setup", "plan", "--claude", "--json"],
      project,
    );

    expect(planned.exitCode).toBe(0);
    expect(
      JSON.parse(planned.stdout).data.changes.map((one: { path: string }) => one.path),
    ).toContain(".operator/config.json");
    expect(await Bun.file(`${project}/.operator/config.json`).exists()).toBe(false);
  });
});

describe("the JSR delivery path", () => {
  let project = "";
  let installRoot = "";
  let launcher: string[] = [];

  beforeAll(async () => {
    project = `${root}/jsr-project`;
    installRoot = `${project}/${ReleaseInstall.paths().root}`;
    await Bun.$`mkdir -p ${installRoot}`.quiet();

    // The registry generates its own manifest, which carries no command, script, or engine field.
    const registryRoot = `${root}/registry-artifact`;
    await Bun.$`cp -R ${artifactRoot} ${registryRoot}`.quiet();
    const artifactManifest = await Bun.file(`${artifactRoot}/package.json`).json();
    await Bun.write(
      `${registryRoot}/package.json`,
      registryManifest({
        packageName: "@jsr/fveracoechea__operator",
        version,
        dependencies: artifactManifest.dependencies,
      }),
    );
    const packed = await ReleasePublish.pack({ artifactRoot: registryRoot, prefix: "package" });
    const registry = startRegistryFake({
      packageName: "@jsr/fveracoechea__operator",
      version,
      tarball: packed.bytes,
      dependencies: artifactManifest.dependencies,
    });
    fakes.push(registry);

    await Bun.write(
      `${installRoot}/bunfig.toml`,
      `[install.scopes]\n"@jsr" = { url = "${registry.url}" }\n`,
    );
    const selected = await ReleaseInstall.select({
      projectRoot: project,
      selection: {
        schemaVersion: 1,
        delivery: "jsr",
        version,
        commit: sourceCommit,
        releaseIdentity: "a".repeat(64),
        skillsIdentity: "b".repeat(64),
        packageVersion: version,
        upstreamSkills: [],
        selectedAt: new Date().toISOString(),
      },
    });
    expect(selected.status).toBe("selected");

    const installed = await run(["bun", "install"], installRoot);
    expect(installed.exitCode).toBe(0);

    launcher = [
      "bun",
      "--no-install",
      "-e",
      'const { main } = await import(Bun.pathToFileURL(Bun.resolveSync("@fveracoechea/operator/cli", `${process.cwd()}/.operator/install`)).href); await main(Bun.argv.slice(1));',
      "--",
    ];
  }, 300_000);

  test("installs the exact package version under the alias the selection records", async () => {
    const manifest = await Bun.file(
      `${installRoot}/node_modules/@fveracoechea/operator/package.json`,
    ).json();

    expect(manifest.name).toBe("@jsr/fveracoechea__operator");
    expect(manifest.version).toBe(version);
    expect(manifest.bin).toBeUndefined();
    expect(manifest.engines).toBeUndefined();
  });

  test("keeps its dependencies out of the application it serves", async () => {
    expect(await Bun.file(`${installRoot}/node_modules/zod/package.json`).exists()).toBe(true);
    expect(await Bun.file(`${project}/node_modules/zod/package.json`).exists()).toBe(false);
  });

  test("preserves lock data a frozen reinstall repeats", async () => {
    expect(await Bun.file(`${installRoot}/bun.lock`).exists()).toBe(true);
    const before = await Bun.file(`${installRoot}/bun.lock`).text();

    const frozen = await run(["bun", "install", "--frozen-lockfile"], installRoot);

    expect(frozen.exitCode).toBe(0);
    expect(await Bun.file(`${installRoot}/bun.lock`).text()).toBe(before);
  });

  test("carries the complete owned-skill assets and the generated schema", async () => {
    const installed = `${installRoot}/node_modules/@fveracoechea/operator`;

    expect(await Bun.file(`${installed}/skills/operator/SKILL.md`).exists()).toBe(true);
    expect(await Bun.file(`${installed}/skills/operator/RECOVERY.md`).exists()).toBe(true);
    expect(await Bun.file(`${installed}/config.schema.json`).exists()).toBe(true);
  });

  test("reports the release version through the importable entry point", async () => {
    const result = await run([...launcher, "--version", "--json"], project);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({ operatorVersion: version });
  });

  test("propagates arguments and the exit meaning of a refusal", async () => {
    const refused = await run([...launcher, "wibble", "--json"], project);

    expect(refused.exitCode).toBe(2);
    expect(JSON.parse(refused.stdout).reason).toBe("invalid_arguments");
  });

  test("keeps the project working directory while it resolves the isolated installation", async () => {
    await Bun.$`git init -q ${project}`.quiet();

    const planned = await run([...launcher, "setup", "plan", "--claude", "--json"], project);

    expect(planned.exitCode).toBe(0);
    const changed = JSON.parse(planned.stdout).data.changes.map(
      (one: { path: string }) => one.path,
    );
    expect(changed).toContain(".operator/config.json");
  });

  test("serves declarations a consumer can typecheck against", async () => {
    await Bun.write(
      `${installRoot}/consumer.ts`,
      'import { main } from "@fveracoechea/operator/cli";\nexport const run: (args: string[]) => Promise<void> = main;\n',
    );
    await Bun.write(
      `${installRoot}/tsconfig.json`,
      `${JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          target: "ESNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          typeRoots: [`${sourceRoot}/node_modules/@types`],
          types: ["bun"],
        },
        files: ["consumer.ts"],
      })}\n`,
    );

    // The compiler comes from this checkout; the declarations come from the installed package.
    const checked = await run(
      ["bunx", "--bun", "--no-install", "tsc", "-p", `${installRoot}/tsconfig.json`],
      sourceRoot,
    );

    expect(`${checked.stdout}${checked.stderr}`).toBe("");
    expect(checked.exitCode).toBe(0);
  }, 300_000);
});
