import { expect } from "bun:test";
// Bun has no recursive copy, real-path, symlink, or directory creation API.
import { cp, mkdir, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { z } from "zod";
import { Environment } from "../environment/main.ts";
import { ReleasePublish } from "../release-publish/main.ts";
import { OperatorRelease } from "./main.ts";
import { registryDependencies, registryManifest, startRegistryFake } from "./fake-registry.ts";
import { registryPackage } from "./registry-install.ts";
import { jsrSchema, releaseSchema } from "./test-schemas.ts";

export const sourceRoot = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
export { installedPackage as launcherPackage, registryPackage } from "./registry-install.ts";

export type BuiltRelease = {
  version: string;
  commit: string;
  identity: string;
  tarball: Uint8Array<ArrayBuffer>;
  dependencies: Record<string, string>;
};

export async function run(command: string[], cwd: string, env: Record<string, string>) {
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

export async function succeed(command: string[], cwd: string, env: Record<string, string>) {
  const result = await run(command, cwd, env);
  expect(result.exitCode, `${command.join(" ")}\n${result.stdout}${result.stderr}`).toBe(0);
  return result;
}

export async function git(args: string[], cwd: string) {
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

/**
 * Real global installations in isolated Bun, settings, and state roots under one temporary root.
 * The registry is a local fake that rewrites the package manifest the way JSR does, so this is a
 * deterministic contract seam, not evidence about the live JSR service.
 */
export async function installFixture(name: string) {
  // Bun reports real global folders, so the root is a real path too.
  const root = `${realpathSync(Environment.read().TMPDIR ?? "/tmp")}/operator-${name}-${crypto.randomUUID()}`;
  const tools = `${root}/tools`;
  await mkdir(tools, { recursive: true });
  await symlink(process.execPath, `${tools}/bun`);
  const gitPath = Bun.which("git", { PATH: Environment.read().PATH });
  expect(gitPath).not.toBeNull();
  await symlink(gitPath ?? "", `${tools}/git`);

  /** Every Bun folder, settings root, and state root of one simulated device. */
  function device(deviceName: string) {
    const base = `${root}/${deviceName}`;
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

  async function checkout(checkoutName: string) {
    const path = `${root}/${checkoutName}`;
    await mkdir(path, { recursive: true });
    await git(["init", "-q"], path);
    await git(
      ["remote", "add", "identity", `https://github.com/example/${checkoutName}.git`],
      path,
    );
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
    await Bun.write(
      `${path}/package.json`,
      `${JSON.stringify({ ...manifest, version }, null, 2)}\n`,
    );
    await git(["init", "-q", "-b", "main"], path);
    await git(["add", "-A"], path);
    await git(["commit", "-q", "-m", "release"], path);
    return (await git(["rev-parse", "HEAD"], path)).stdout.trim();
  }

  /** Builds one release and packs it with the manifest the registry would serve. */
  async function release(version: string, label: string): Promise<BuiltRelease> {
    const repository = `${root}/release-source-${label}`;
    const commit = await sourceRepository(repository, version);
    await symlink(`${sourceRoot}/node_modules`, `${repository}/node_modules`);
    const artifactRoot = `${root}/artifact-${label}`;
    const result = await OperatorRelease.build({ sourceRoot: repository, artifactRoot, commit });
    expect(result.status).toBe("built");
    const record = releaseSchema.parse(await Bun.file(`${artifactRoot}/release.json`).json());
    const dependencies = registryDependencies(
      jsrSchema.parse(await Bun.file(`${artifactRoot}/jsr.json`).json()),
    );
    await Bun.write(
      `${artifactRoot}/package.json`,
      registryManifest({ packageName: registryPackage, version, dependencies }),
    );
    const packed = await ReleasePublish.pack({ artifactRoot, prefix: "package" });
    return {
      version,
      commit,
      identity: record.artifactIdentity,
      tarball: packed.bytes,
      dependencies,
    };
  }

  /** Points the device's `@jsr` scope at the fake registry, which serves one release. */
  async function serve(machine: ReturnType<typeof device>, built: BuiltRelease) {
    const registry = startRegistryFake({ packageName: registryPackage, ...built });
    await Bun.write(
      `${machine.env.XDG_CONFIG_HOME}/.bunfig.toml`,
      `[install.scopes]\n"@jsr" = { url = "${registry.url}" }\n`,
      { createPath: true },
    );
    return registry;
  }

  return { root, tools, device, checkout, sourceRepository, release, serve };
}
