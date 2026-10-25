import { expect, test } from "bun:test";
// Bun has no directory creation, temporary directory, symlink, or directory removal API.
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { z } from "zod";
import { OperatorRelease } from "../../../modules/operator-release/main.ts";
import { prepare } from "./prepare.ts";

const sourceRoot = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");

test("the real release excludes the Result experiments, page, and experimental dependencies", async () => {
  const root = await mkdtemp("/tmp/opencode/operator-261-artifact-");
  try {
    const artifactRoot = `${root}/artifact`;
    const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: sourceRoot, stdout: "pipe" })
      .stdout.toString()
      .trim();
    expect((await OperatorRelease.build({ sourceRoot, artifactRoot, commit })).status).toBe(
      "built",
    );
    const files = await OperatorRelease.contents({ artifactRoot });
    expect(files.some((path) => /prototype|comparison\.html|^scripts\//.test(path))).toBe(false);
    const manifest = z
      .object({ dependencies: z.record(z.string(), z.string()) })
      .parse(await Bun.file(`${artifactRoot}/package.json`).json());
    expect(manifest.dependencies).not.toHaveProperty("neverthrow");
    expect(manifest.dependencies).not.toHaveProperty("effect");
    expect(manifest.dependencies).not.toHaveProperty("drizzle-orm");
    expect(manifest.dependencies).not.toHaveProperty("pg");
    expect(Object.keys(manifest.dependencies).some((name) => name.includes("unthrown"))).toBe(
      false,
    );
    await symlink(`${sourceRoot}/node_modules`, `${artifactRoot}/node_modules`);
    const help = Bun.spawnSync([process.execPath, `${artifactRoot}/cli.js`, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: root,
        XDG_STATE_HOME: `${root}/state`,
        XDG_CONFIG_HOME: `${root}/config`,
      },
    });
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toBe("Usage: operator --help | --version [--json]\n");
  } finally {
    await rm(root, { recursive: true });
  }
}, 30000);

test("candidate root imports survive the actual release builder, declarations, and ESM execution", async () => {
  const root = await prepare();
  for (const [name, version, imported, body] of [
    ["unthrown", "5.12.1", '{ Ok } from "unthrown"', 'console.log(Ok("release-smoke").get())'],
    [
      "neverthrow",
      "8.2.0",
      '{ ok } from "neverthrow"',
      'ok("release-smoke").match(console.log, console.error)',
    ],
    [
      "effect",
      "4.0.6",
      '{ Result } from "effect"',
      'Result.match(Result.succeed("release-smoke"), { onSuccess: console.log, onFailure: console.error })',
    ],
  ]) {
    const source = `${root}/release-source-${name}`;
    await mkdir(`${source}/skills`, { recursive: true });
    await mkdir(`${source}/docs/jsr`, { recursive: true });
    await Bun.write(`${source}/docs/jsr/README.md`, "Disposable release compatibility check.\n");
    await Bun.write(
      `${source}/package.json`,
      JSON.stringify({
        name: "@fveracoechea/operator",
        version: "0.0.0",
        license: "MIT",
        engines: { bun: ">=1.4.0" },
        dependencies: { [name!]: version },
      }),
    );
    await symlink(`${root}/node_modules`, `${source}/node_modules`);
    await Bun.write(
      `${source}/cli.ts`,
      `/** Disposable compatibility check. @module */\nimport ${imported};\n/** Runs a scratch release check. */\nexport async function main(args: string[]): Promise<void> { void args; ${body}; }\nif (import.meta.main) await main([]);\n`,
    );
    const artifactRoot = `${root}/release-${name}`;
    const result = await OperatorRelease.build({
      sourceRoot: source,
      artifactRoot,
      commit: "0".repeat(40),
    });
    expect(result).toMatchObject({ status: "built" });
    expect(await Bun.file(`${artifactRoot}/cli.d.ts`).exists()).toBe(true);
    const jsr = z
      .object({ imports: z.record(z.string(), z.string()) })
      .parse(await Bun.file(`${artifactRoot}/jsr.json`).json());
    expect(jsr.imports[name!]).toBe(`npm:${name}@${version}`);
    await symlink(`${root}/node_modules`, `${artifactRoot}/node_modules`);
    const run = Bun.spawnSync([process.execPath, `${artifactRoot}/cli.js`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe("release-smoke\n");
  }
}, 30000);
