import { afterAll, expect, test } from "bun:test";
// Bun has no temporary-directory or recursive-removal API.
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { checkStructure } from "./structure.ts";
import { normalizeProjectConfig } from "./configuration.ts";

const roots: string[] = [];
const script = path.join(import.meta.dir, "structure-command.ts");
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function project(files: Record<string, string>, settings = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "deep-modules-structure-"));
  roots.push(root);
  await Bun.write(path.join(root, ".oxlintrc.json"), JSON.stringify({ settings }));
  for (const [name, content] of Object.entries(files))
    await Bun.write(path.join(root, name), content);
  return root;
}

async function check(root: string, args: string[] = []) {
  const child = Bun.spawn([process.execPath, script, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { exitCode, stderr };
}

test("the structure command discovers missing top-level and nested TSX entries", async () => {
  const root = await project({ "src/modules/movie/selectors/value.tsx": "export const id = 1;" });
  const missing = await check(root);
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr).toContain(
    "src/modules/movie/main.ts: every module requires one public interface",
  );
  expect(missing.stderr).toContain(
    "src/modules/movie/selectors/main.ts: every module requires one public interface",
  );
  expect(missing.stderr).toContain("deep-modules/structure");
  const url = missing.stderr.match(/file:\/\/[^\s]+\.md/)?.[0];
  expect(url).toBeDefined();
  if (url) expect(await Bun.file(new URL(url)).text()).toContain("entry");
});

test("each object and framework entry needs its own corresponding beside-test", async () => {
  const root = await project({
    "src/modules/movie/main.ts": "export const Movie = {};",
    "src/modules/movie/main.server.ts": "export const Movie = {};",
    "src/modules/movie/selectors/main.tsx": "export function ids() {}",
    "src/modules/server/$functions.ts": "export function load() {}",
    "src/modules/movie/main.test.ts": "export {};",
  });
  const missing = await check(root);
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr).toContain("src/modules/movie/main.server.test.ts");
  expect(missing.stderr).toContain("src/modules/movie/selectors/main.test.tsx");
  expect(missing.stderr).toContain("src/modules/server/$functions.test.ts");
  expect(missing.stderr).not.toContain("src/modules/movie/main.test.ts:");
  for (const file of [
    "src/modules/movie/main.server.test.ts",
    "src/modules/movie/selectors/main.behavior.test.tsx",
    "src/modules/server/$functions.test.ts",
  ])
    await Bun.write(path.join(root, file), "export {};");
  expect(await check(root)).toEqual({ exitCode: 0, stderr: "" });
});

test("a server entry test does not cover a separate client entry", async () => {
  const root = await project({
    "src/modules/movie/main.ts": "export const Movie = {};",
    "src/modules/movie/main.server.ts": "export const Movie = {};",
    "src/modules/movie/main.server.test.ts": "export {};",
  });
  const result = await check(root);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("src/modules/movie/main.test.ts:");
  expect(result.stderr).not.toContain("src/modules/movie/main.server.test.ts:");
});

test("shared discovery ignores excluded resources, declarations and test-only folders", async () => {
  const root = await project(
    {
      "web/features/movie/interface.tsx": "export const Movie = {};",
      "web/features/movie/interface.test.tsx": "export {};",
      "web/features/movie/resources/image.ts": "export {};",
      "web/features/movie/generated/client.tsx": "export {};",
      "web/features/movie/types/model.d.ts": "export {};",
      "web/features/movie/fixtures/only.test.ts": "export {};",
      "web/features/schema/schemas.ts": "export type Id = string;",
      "web/features/server/$functions.ts": "export function load() {}",
      "web/features/server/$functions.test.ts": "export {};",
      "web/shared/helper.ts": "export const value = 1;",
    },
    {
      "deep-modules": {
        applicationRoots: ["web"],
        moduleRoots: ["web/features"],
        libraryRoots: ["web/shared"],
        objectEntries: ["interface.tsx"],
        exclusions: ["web/features/movie/resources", "web/features/movie/generated"],
      },
    },
  );
  expect(await check(root)).toEqual({ exitCode: 0, stderr: "" });
});

test("production placement rejects flat modules and stray code but preserves explicit legal locations", async () => {
  const root = await project(
    {
      "src/modules/flat.tsx": "export {};",
      "outside/wrong.tsx": "export {};",
      "stray.ts": "export {};",
      "src/cli.ts": "export {};",
      "src/lib/value.ts": "export {};",
      "tools/check.ts": "export {};",
      "packages/deep-modules/src/tool.ts": "export {};",
      "root.test.ts": "export {};",
      "root.config.ts": "export {};",
      "models.d.ts": "export {};",
    },
    { "deep-modules": { allowedFiles: ["src/cli.ts"] } },
  );
  const result = await check(root);
  expect(result.exitCode).toBe(1);
  const lines = result.stderr.trim().split("\n");
  expect(lines.map((line) => line.split(":")[0])).toEqual([
    "outside/wrong.tsx",
    "src/modules/flat.tsx",
    "stray.ts",
  ]);
  expect(lines[1]).toContain("production files must be inside a feature module");
  expect(lines[0]).toContain("production TypeScript must live");
  await rm(path.join(root, "outside"), { recursive: true });
  await rm(path.join(root, "src/modules/flat.tsx"));
  await rm(path.join(root, "stray.ts"));
  expect(await check(root)).toEqual({ exitCode: 0, stderr: "" });
});

test("invalid command arguments and configuration fail visibly with usage exit 2", async () => {
  const root = await project({});
  for (const args of [["--unknown"], ["--config"], ["--config", "missing.json"]]) {
    const result = await check(root, args);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("deep-modules/structure");
  }
  await Bun.write(
    path.join(root, ".oxlintrc.json"),
    '{"settings":{"deep-modules":{"moduleRoots":[]}}}',
  );
  const invalid = await check(root);
  expect(invalid.exitCode).toBe(2);
  expect(invalid.stderr).toContain("moduleRoots");
});

test("the command reads inherited consumer settings and an explicit config path", async () => {
  const root = await project({ "launch.ts": "export {};" });
  await Bun.write(
    path.join(root, "base.json"),
    JSON.stringify({
      settings: { "deep-modules": { allowedFiles: ["launch.ts"] } },
    }),
  );
  await Bun.write(path.join(root, "custom.json"), JSON.stringify({ extends: ["./base.json"] }));
  expect(await check(root, ["--config", "custom.json"])).toEqual({ exitCode: 0, stderr: "" });
  await Bun.write(path.join(root, "base.json"), '{"extends":["./custom.json"]}');
  const cycle = await check(root, ["--config", "custom.json"]);
  expect(cycle.exitCode).toBe(2);
  expect(cycle.stderr).toContain("configuration cycle");
});

test("the shared checker requires behavior entries even when a schema exists beside private code", async () => {
  const root = await project({
    "src/modules/movie/schemas.ts": "export type Id = string;",
    "src/modules/movie/private.ts": "export const id = 1;",
  });
  const config = normalizeProjectConfig({}, root);
  expect(checkStructure(config).map((line) => line.split(" [")[0])).toEqual([
    "src/modules/movie/main.ts: every module requires one public interface",
  ]);
  await rm(path.join(root, "src/modules/movie/private.ts"));
  expect(checkStructure(config)).toEqual([]);
});

test("excluded entry files do not require tests or count as behavior", async () => {
  const root = await project(
    {
      "src/modules/movie/main.ts": "export const Movie = {};",
      "src/modules/movie/main.server.ts": "generated",
      "src/modules/movie/main.test.ts": "export {};",
    },
    { "deep-modules": { exclusions: ["src/modules/movie/main.server.ts"] } },
  );
  expect(await check(root)).toEqual({ exitCode: 0, stderr: "" });
});

test("default configuration is optional but an unreadable or malformed explicit configuration fails", async () => {
  const root = await project({ "src/lib/value.ts": "export const id = 1;" });
  await rm(path.join(root, ".oxlintrc.json"));
  expect(await check(root)).toEqual({ exitCode: 0, stderr: "" });
  await Bun.write(path.join(root, "broken.json"), "{");
  expect((await check(root, ["--config", "broken.json"])).exitCode).toBe(2);
});

test("placement follows configured tooling roots and explicit files rather than Operator paths", async () => {
  const root = await project(
    {
      "build-tools/check.tsx": "export {};",
      "entry.tsx": "export {};",
      "tools/no-longer-tooling.ts": "export {};",
    },
    { "deep-modules": { toolingRoots: ["build-tools"], allowedFiles: ["entry.tsx"] } },
  );
  const result = await check(root);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.split(":")[0]).toBe("tools/no-longer-tooling.ts");
  await rm(path.join(root, "tools"), { recursive: true });
  expect(await check(root)).toEqual({ exitCode: 0, stderr: "" });
});
