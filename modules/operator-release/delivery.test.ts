import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// Bun has no recursive copy, symlink, or directory removal API.
import { cp, mkdir, rm, symlink } from "node:fs/promises";
import { OperatorRelease } from "./main.ts";
import { ReleasePublish } from "../release-publish/main.ts";
import {
  registryDependencies,
  registryManifest,
  type RegistryFake,
  startRegistryFake,
} from "./fake-registry.ts";

const sourceRoot = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-delivery-${crypto.randomUUID()}`;
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
      ...process.env,
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
  version = (await Bun.file(`${artifactRoot}/release.json`).json()).version;
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
  const dependencies = registryDependencies(await Bun.file(`${artifactRoot}/jsr.json`).json());
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
  registry?.stop();
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
    expect(JSON.parse(result.stdout).data.operatorVersion).toBe(version);
    expect(
      await Bun.file(`${sourceProject}/node_modules/@fveracoechea/operator/cli.js`).exists(),
    ).toBe(false);
    const untrusted = await run([process.execPath, "pm", "untrusted"], sourceProject);
    expect(untrusted.stdout).toContain("@fveracoechea/operator");
  });
});

describe("real registry-artifact delivery", () => {
  test("runs the exported CLI after the registry drops binary and engine declarations", async () => {
    const manifest = await Bun.file(
      `${registryProject}/node_modules/@fveracoechea/operator/package.json`,
    ).json();
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
    expect(JSON.parse(result.stdout).data).toMatchObject({ operatorVersion: version, commit });
    expect(JSON.parse(result.stdout).data).not.toHaveProperty("selection");
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
  const release = await Bun.file(`${rejected}/release.json`).json();
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
