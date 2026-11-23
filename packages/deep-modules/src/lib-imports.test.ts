import { expect, test } from "bun:test";
import { lintProject } from "../../../tools/oxlint/check.ts";

const check = lintProject();
const policy = JSON.stringify({
  categories: { correctness: "off" },
  jsPlugins: [{ name: "deep-modules", specifier: "./packages/deep-modules/src/index.ts" }],
  rules: { "deep-modules/lib-imports": "error" },
});

test("libraries reject application and tooling dependencies through every literal loading form", async () => {
  for (const source of [
    'import "../modules/movie/main.ts";',
    'import type { Id } from "../modules/movie/schemas.ts";',
    'export * from "../../tools/task.ts";',
    'export type Task = import("../../tools/task.ts").Task;',
    'import Task = require("../../tools/task.ts");',
    'const task = require("../../tools/task.ts");',
    'const task = require.resolve("../../tools/task.ts");',
    'const task = import("../../packages/tool/src/main.ts");',
    'import "../cli.ts";',
  ]) {
    const result = await check(source, {
      files: {
        ".oxlintrc.json": policy,
        "src/modules/movie/main.ts": "export const Movie = { run() {} };",
        "src/modules/movie/schemas.ts": "export type Id = string;",
        "tools/task.ts": "export type Task = string;",
        "packages/tool/src/main.ts": "export {};",
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings).toEqual(["1 deep-modules(lib-imports)"]);
    expect(result.stdout).toContain("docs/lib-imports.md");
  }
});

test("library-local, external packages and nonlibrary callers are not library violations", async () => {
  for (const [file, source] of [
    ["src/lib/probe.ts", 'import "./other.ts"; import "zod"; import "node:path";'],
    ["src/modules/movie/main.ts", 'import "../../lib/other.ts";'],
  ] as const) {
    const result = await check(source, {
      path: file,
      files: { ".oxlintrc.json": policy, "src/lib/other.ts": "export {};" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.codes).toEqual([]);
  }
});
