import { expect, test } from "bun:test";
import { lintProject } from "../../../tools/oxlint/check.ts";

const check = lintProject();
const policy = JSON.stringify({
  categories: { correctness: "off" },
  jsPlugins: [{ name: "deep-modules", specifier: "./packages/deep-modules/src/index.ts" }],
  rules: { "deep-modules/module-imports": "error" },
});

test("shared static loading recognizes Node bindings rather than unrelated shadowed functions", async () => {
  for (const source of [
    'import { value } from "../movie/private.ts";',
    'import type { Value } from "../movie/private.ts";',
    'import "../movie/private.ts";',
    'export { value } from "../movie/private.ts";',
    'export * from "../movie/private.ts";',
    'export type Value = import("../movie/private.ts").Value;',
    'const loaded = import("../movie/private.ts");',
    'const loaded = require("../movie/private.ts");',
    'const loaded = require.resolve("../movie/private.ts");',
    'import loaded = require("../movie/private.ts");',
    'const load = require; const loaded = load("../movie/private.ts");',
    'const loaded = module.require("../movie/private.ts");',
    'import { createRequire as makeRequire } from "node:module"; const load = makeRequire(import.meta.url); load("../movie/private.ts");',
    'import * as nodeModule from "node:module"; const load = nodeModule.createRequire(import.meta.url); load("../movie/private.ts");',
  ]) {
    const result = await check(source, {
      path: "src/modules/tv/main.ts",
      files: {
        ".oxlintrc.json": policy,
        "src/modules/movie/private.ts": "export const value = 1; export type Value = string;",
      },
    });
    expect(result.findings).toEqual([
      `${source.includes('"node:module"') ? 3 : 1} deep-modules(module-imports)`,
    ]);
    const good = await check(source.replaceAll("private.ts", "main.ts"), {
      path: "src/modules/tv/main.ts",
      files: {
        ".oxlintrc.json": policy,
        "src/modules/movie/main.ts": "export const value = 1; export type Value = string;",
      },
    });
    expect(good.exitCode).toBe(0);
    expect(good.codes).toEqual([]);
  }
  for (const source of [
    'function run(require: (name: string) => void) { require("../movie/private.ts"); }',
    'const require = (name: string) => name; require("../movie/private.ts");',
    'function run(require: { resolve(name: string): void }) { require.resolve("../movie/private.ts"); }',
    'const target = "../movie/private.ts"; import(target);',
    'const a = b; const b = a; a("../movie/private.ts");',
    'function run(module: { require(name: string): void }) { module.require("../movie/private.ts"); }',
    'function createRequire() { return (name: string) => name; } const load = createRequire(); load("../movie/private.ts");',
  ]) {
    const result = await check(source, {
      path: "src/modules/tv/main.ts",
      files: { ".oxlintrc.json": policy, "src/modules/movie/private.ts": "export {};" },
    });
    expect(result.codes).toEqual([]);
  }
});
