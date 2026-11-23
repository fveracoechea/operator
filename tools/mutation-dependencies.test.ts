import { afterAll, expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { mutationUnitIdentity as assessIdentity } from "./mutation-dependencies.ts";

async function mutationUnitIdentity(...args: Parameters<typeof assessIdentity>) {
  const result = await assessIdentity(...args);
  return result.eligible ? result.identity : undefined;
}

const root = await mkdtemp(path.join(tmpdir(), "mutation-dependencies-"));
afterAll(() => rm(root, { recursive: true, force: true }));

async function fixture(source = 'export { value } from "./helper.ts";') {
  const directory = path.join(root, crypto.randomUUID());
  await Bun.write(`${directory}/unit.ts`, source);
  await Bun.write(`${directory}/helper.ts`, "export const value = 1;");
  await Bun.write(`${directory}/unit.test.ts`, 'import { value } from "./unit.ts";');
  await Bun.write(`${directory}/package.json`, '{"scripts":{"test":"bun test --isolate"}}');
  await Bun.write(`${directory}/data`, "fixture");
  const unit = { name: "unit.ts", source, tests: ["./unit.test.ts"], patterns: ["unit.ts"] };
  return { directory, unit };
}

async function boundedIdentity(directory: string, expression: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { mutationUnitIdentity } from ${JSON.stringify(path.join(import.meta.dir, "mutation-dependencies.ts"))}; console.log((await ${expression}).identity);`,
    ],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill(), 500);
  try {
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return `${code}:${output.trim()}${error}`;
  } finally {
    clearTimeout(timer);
  }
}

test("external snapshots invalidate only their owning unit across additions, edits and deletions", async () => {
  const { directory, unit } = await fixture();
  const other = {
    name: "other.ts",
    source: "export const other = 2;",
    tests: ["./other.test.ts"],
    patterns: ["other.ts"],
  };
  await Bun.write(`${directory}/other.ts`, other.source);
  await Bun.write(`${directory}/other.test.ts`, 'import { other } from "./other.ts";');
  const initial = await mutationUnitIdentity(directory, unit, "engine");
  const unrelated = await mutationUnitIdentity(directory, other, "engine");
  expect(initial).toMatch(/^[a-f\d]{64}$/);
  expect(unrelated).toMatch(/^[a-f\d]{64}$/);
  const snapshot = `${directory}/__snapshots__/unit.test.ts.snap`;
  await Bun.write(snapshot, 'exports["value 1"] = `1`;');
  const added = await mutationUnitIdentity(directory, unit, "engine");
  expect(added).toMatch(/^[a-f\d]{64}$/);
  expect(added).not.toBe(initial);
  expect(await mutationUnitIdentity(directory, other, "engine")).toBe(unrelated);
  await Bun.write(snapshot, 'exports["value 1"] = `2`;');
  expect(await mutationUnitIdentity(directory, unit, "engine")).not.toBe(added);
  expect(await mutationUnitIdentity(directory, other, "engine")).toBe(unrelated);
  await rm(snapshot);
  expect(await mutationUnitIdentity(directory, unit, "engine")).toBe(initial);
  expect(await mutationUnitIdentity(directory, other, "engine")).toBe(unrelated);
});

test("unit identities follow transitive production, test, fixture, configuration and selection inputs", async () => {
  const { directory, unit } = await fixture();
  const initial = await mutationUnitIdentity(directory, unit, "engine-a");
  expect(initial).toMatch(/^[a-f\d]{64}$/);
  await Bun.write(`${directory}/unrelated.ts`, "export const unrelated = false;");
  expect(await mutationUnitIdentity(directory, unit, "engine-a")).toBe(initial);
  expect(await mutationUnitIdentity(directory, unit, "engine-b")).not.toBe(initial);
  expect(
    await mutationUnitIdentity(directory, { ...unit, patterns: ["unit.ts:1:0-1:5"] }, "engine-a"),
  ).not.toBe(initial);
  await Bun.write(`${directory}/helper.ts`, 'export { value } from "./nested.ts";');
  await Bun.write(`${directory}/nested.ts`, "export const value = 2;");
  const transitive = await mutationUnitIdentity(directory, unit, "engine-a");
  expect(transitive).not.toBe(initial);
  await Bun.write(`${directory}/nested.ts`, "export const value = 3;");
  expect(await mutationUnitIdentity(directory, unit, "engine-a")).not.toBe(transitive);
  await Bun.write(`${directory}/unit.test.ts`, 'import "./test-helper.ts";');
  await Bun.write(`${directory}/test-helper.ts`, 'await Bun.file("data.bin").bytes();');
  await Bun.write(`${directory}/data.bin`, new Uint8Array([0xff]));
  const binary = await mutationUnitIdentity(directory, unit, "engine-a");
  expect(binary).toMatch(/^[a-f\d]{64}$/);
  await Bun.write(`${directory}/data.bin`, new Uint8Array([0xfe]));
  expect(await mutationUnitIdentity(directory, unit, "engine-a")).not.toBe(binary);
  const beforeConfig = await mutationUnitIdentity(directory, unit, "engine-a");
  await Bun.write(`${directory}/bunfig.toml`, "[test]\ntimeout = 1234");
  expect(await mutationUnitIdentity(directory, unit, "engine-a")).not.toBe(beforeConfig);
});

test.each([
  'await import("./helper.ts");',
  'const name = "./helper.ts"; await import(name);',
  'import "./missing.ts";',
  'import "unresolved-package";',
  'await Bun.file("missing-fixture").text();',
  'await Bun.file("../outside").text();',
  'const input = "data"; await Bun.file(input).text();',
  'const read = Bun.file; await read("data").text();',
  'const runtime = Bun; await runtime.file("data").text();',
  'import { readFileSync as read } from "node:fs"; read("data");',
  "console.log(process.env.INPUT);",
  'eval("input");',
  "export const invalid = ;",
  'export * from "node:fs";',
  'export { readFileSync } from "fs";',
  'import * as fs from "node:fs"; fs.readFileSync("data");',
  'import fs from "fs"; fs.readFileSync("data");',
  'import { appendFileSync, readFileSync } from "node:fs";',
  'import { "readFileSync" as read } from "node:fs";',
  'await Bun.file("/external").text();',
  "await Bun.file().text();",
  'await Bun.file?.("data").text();',
  'const file = Bun["file"];',
  "console.log(globalThis.input);",
  "console.log(global.input);",
  'Function("input")();',
  'require("./helper.ts");',
  'await fetch("https://example.test");',
  'new URL("file:///input");',
  'new WebSocket("ws://example.test");',
  "Date.now();",
  'import { readFile } from "node:fs/promises";',
  'import { join } from "node:path";',
  'await Bun.spawn(["command"]);',
  'new Bun.file("data");',
])("uncertain inputs never receive a reusable identity: %s", async (source) => {
  const { directory, unit } = await fixture(source);
  expect(await mutationUnitIdentity(directory, unit, "engine")).toBeUndefined();
});

test.each([
  'import { test, expect } from "bun:test"; test("value", () => expect(1).toBe(1));',
  'import { appendFileSync } from "node:fs"; appendFileSync("/receipt", "run");',
  'import { appendFileSync as append } from "fs"; append("/receipt", "run");',
  'export * from "./helper.ts";',
  'export { value } from "./helper.ts";',
  "const value: number = 1; export default value;",
  'const component = <div title="hello" />;',
  "const component = <process />;",
  'await Bun.write("/receipt", "run");',
  'await Bun["file"]("data").text();',
  "console.log(process.pid);",
  "console.log(process.env.__STRYKER_ACTIVE_MUTANT__);",
  'const object = { file: () => 1 }; object.file(); object["file"]();',
])("static syntax retains a reusable identity: %s", async (source) => {
  const { directory, unit } = await fixture(source);
  expect(await mutationUnitIdentity(directory, unit, "engine")).toMatch(/^[a-f\d]{64}$/);
});

test("cyclic imports and ignored output files do not create false invalidation", async () => {
  const { directory, unit } = await fixture();
  await Bun.write(`${directory}/helper.ts`, 'import "./unit.ts"; export const value = 1;');
  const expression = `mutationUnitIdentity(${JSON.stringify(directory)}, ${JSON.stringify(unit)}, "engine")`;
  const first = await boundedIdentity(directory, expression);
  expect(first).toMatch(/^0:[a-f\d]{64}$/);
  await Bun.write(`${directory}/.mutation-runs/report.json`, "not input");
  await Bun.write(`${directory}/node_modules/generated/config.json`, "not input");
  expect(await boundedIdentity(directory, expression)).toBe(first);
  await Bun.write(`${directory}/tools/test-watchdog.ts`, 'import "./runner-helper.ts";');
  await Bun.write(`${directory}/tools/runner-helper.ts`, "export const timeout = 1;");
  const runner = await boundedIdentity(directory, expression);
  expect(runner).toMatch(/^0:[a-f\d]{64}$/);
  expect(runner).not.toBe(first);
  await Bun.write(`${directory}/tools/runner-helper.ts`, "export const timeout = 2;");
  expect(await boundedIdentity(directory, expression)).not.toBe(runner);
});

test("custom commands and configuration preloads conservatively bypass reuse", async () => {
  const { directory, unit } = await fixture();
  await Bun.write(`${directory}/package.json`, '{"scripts":{"test":"bun custom-runner.ts"}}');
  expect(await mutationUnitIdentity(directory, unit, "engine")).toBeUndefined();
  await Bun.write(`${directory}/package.json`, '{"scripts":{"test":"bun test"}}');
  await Bun.write(`${directory}/bunfig.toml`, "[test]\ntimeout = 1000");
  expect(await mutationUnitIdentity(directory, unit, "engine")).toMatch(/^[a-f\d]{64}$/);
  await Bun.write(
    `${directory}/not-preloaded.ts`,
    'export const preload = "not a configuration file";',
  );
  expect(await mutationUnitIdentity(directory, unit, "engine")).toMatch(/^[a-f\d]{64}$/);
  await Bun.write(`${directory}/bunfig.toml`, '[test]\npreload = ["./preload.ts"]');
  expect(await mutationUnitIdentity(directory, unit, "engine")).toBeUndefined();
});

test("the watchdog rejection identifies command ineligibility rather than a cache miss", async () => {
  const { directory, unit } = await fixture();
  await Bun.write(`${directory}/package.json`, '{"scripts":{"test":"bun tools/test-watchdog.ts"}}');
  expect(await assessIdentity(directory, unit, "engine")).toEqual({
    eligible: false,
    reason: "unsupported-test-command",
  });
});

test("existing external imports, external files and unsupported linked inputs cannot be cached", async () => {
  const { directory, unit } = await fixture();
  const outside = path.join(root, `${crypto.randomUUID()}.ts`);
  await Bun.write(outside, "export const external = 1;");
  await Bun.write(
    `${directory}/unit.ts`,
    `import ${JSON.stringify(path.relative(directory, outside))};`,
  );
  expect(await mutationUnitIdentity(directory, unit, "engine")).toBeUndefined();
  await Bun.write(`${directory}/unit.ts`, 'import "pure-dependency";');
  await Bun.write(`${directory}/node_modules/pure-dependency/package.json`, '{"main":"index.js"}');
  await Bun.write(
    `${directory}/node_modules/pure-dependency/index.js`,
    "export const external = 1;",
  );
  expect(await mutationUnitIdentity(directory, unit, "engine")).toBeUndefined();
  await Bun.write(`${directory}/unit.ts`, 'await Bun.file("linked-data").text();');
  await Bun.write(`${directory}/real-data`, "fixture");
  await symlink(`${directory}/real-data`, `${directory}/linked-data`);
  expect(await mutationUnitIdentity(directory, unit, "engine")).toBeUndefined();
  await Bun.write(
    `${directory}/unit.ts`,
    `await Bun.file(${JSON.stringify(`${directory}/data`)}).text();`,
  );
  expect(await mutationUnitIdentity(directory, unit, "engine")).toBeUndefined();
});

test("typed module extensions follow imports while similarly named binary fixtures stay opaque", async () => {
  const { directory, unit } = await fixture('import "./helper.cts";');
  await Bun.write(
    `${directory}/helper.cts`,
    'import "./nested.ts"; export const value: number = 1;',
  );
  await Bun.write(`${directory}/nested.ts`, "export const nested = 1;");
  const before = await mutationUnitIdentity(directory, unit, "engine");
  expect(before).toMatch(/^[a-f\d]{64}$/);
  await Bun.write(`${directory}/nested.ts`, "export const nested = 2;");
  expect(await mutationUnitIdentity(directory, unit, "engine")).not.toBe(before);
  await Bun.write(`${directory}/unit.ts`, 'await Bun.file("data.ts.bin").bytes();');
  await Bun.write(`${directory}/data.ts.bin`, new Uint8Array([0xff]));
  expect(await mutationUnitIdentity(directory, unit, "engine")).toMatch(/^[a-f\d]{64}$/);
});

test("configuration identity includes each supported extension and excludes near-miss names", async () => {
  const { directory, unit } = await fixture();
  const initial = await mutationUnitIdentity(directory, unit, "engine");
  await mkdir(`${directory}/directory.json`);
  expect(await mutationUnitIdentity(directory, unit, "engine")).toBe(initial);
  for (const name of ["settings.json.txt", "settings.yaml.txt", "settings.notenv"]) {
    await Bun.write(`${directory}/${name}`, "not config");
    expect(await mutationUnitIdentity(directory, unit, "engine")).toBe(initial);
  }
  for (const name of [
    "settings.yml",
    "settings.yaml",
    "settings.json",
    "bun.lock",
    "bun.lockb",
    ".env.local",
  ]) {
    const before = await mutationUnitIdentity(directory, unit, "engine");
    await Bun.write(`${directory}/${name}`, "first");
    const added = await mutationUnitIdentity(directory, unit, "engine");
    expect(added).not.toBe(before);
    await Bun.write(`${directory}/${name}`, "second");
    expect(await mutationUnitIdentity(directory, unit, "engine")).not.toBe(added);
  }
  await Bun.write(`${directory}/package.json`, "{}");
  expect(await mutationUnitIdentity(directory, unit, "engine")).toBeUndefined();
});
