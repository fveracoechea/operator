import { afterAll, expect, test } from "bun:test";
// Bun has no temporary directory, permission, link, or recursive removal API.
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const sourceRoot = path.resolve(import.meta.dir, "..");
const script = path.join(import.meta.dir, "check-module-shape.ts");
const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { force: true, recursive: true });
});

/** A small project root, so the checker reads only the files a case names. */
async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "operator-module-shape-"));
  roots.push(root);
  await symlink(path.join(sourceRoot, "node_modules"), path.join(root, "node_modules"));
  await Bun.write(path.join(root, "package.json"), '{ "name": "module-shape-probe" }\n');
  await Bun.write(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { module: "preserve", noEmit: true, allowImportingTsExtensions: true },
    }),
  );
  for (const [name, text] of Object.entries(files)) {
    await Bun.write(path.join(root, name), text, { createPath: true });
  }
  return root;
}

async function checkShape(root: string): Promise<{ exitCode: number; errors: string[] }> {
  const child = Bun.spawn([process.execPath, script], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { exitCode, errors: stderr.split("\n").filter(Boolean) };
}

test("accepts module interfaces, lib, tooling, and allowed root files", async () => {
  const root = await project({
    "modules/alpha/main.ts":
      'import { value } from "../../lib/value.ts";\nconst offset = 1;\nexport const Alpha = { run() { return value() + offset; } };\n',
    "modules/alpha/private.ts": "export function hidden() {}\n",
    // Only a module's top-level main.ts is its interface.
    "modules/alpha/nested/main.ts": "export function nested() {}\nexport const other = 1;\n",
    "modules/beta/main.ts":
      'import { Alpha } from "../alpha/main.ts";\nexport const Beta = { run() { return Alpha.run(); } };\n',
    // A main.ts outside a module folder, or a longer name, is not a module interface.
    "lib/modules/kit/main.ts": "export function kit() {}\nexport const other = 1;\n",
    "modules/alpha/main.ts.helper.ts": "export function helper() {}\nexport const other = 1;\n",
    "lib/value.ts": "export function value() { return 1; }\n",
    "lib/consumer.ts": 'import { value } from "./value.ts";\nexport const twice = value() * 2;\n',
    "lib/unknown-type.ts": "export type Unknown = typeof import(Missing);\n",
    "tools/oxlint/rule.ts": "export const rule = 1;\n",
    "scripts/task.ts": "export const task = 1;\n",
    "cli.ts": 'export { Alpha } from "./modules/alpha/main.ts";\n',
    "root.test.ts": "export {};\n",
    "probe.config.ts": "export {};\n",
  });

  expect(await checkShape(root)).toEqual({ exitCode: 0, errors: [] });
});

test("reports each boundary violation once, in sorted order", async () => {
  const root = await project({
    "modules/alpha/main.ts": "export const Alpha = { run() {} };\n",
    "modules/alpha/private.ts": "export function hidden() {}\n",
    "modules/beta/main.ts":
      'import "../alpha/private.ts";\nexport const Beta = { run() {} };\nexport function helper() {}\n',
    "modules/gamma/private.ts": "export {};\n",
    "modules/flat.ts": "export {};\n",
    "tools/other.ts": "export {};\n",
    "stray.ts": "export {};\n",
    "lib/dynamic.ts": 'export function load() { return import("../modules/alpha/private.ts"); }\n',
    "lib/type.ts": 'export type App = typeof import("../modules/alpha/main.ts");\n',
    "lib/equals.ts": 'import App = require("../scripts/task.ts");\nexport { App };\n',
    "scripts/task.ts": "export const task = 1;\n",
    "lib/locked.ts": "export {};\n",
  });
  await chmod(path.join(root, "lib/locked.ts"), 0o000);

  expect(await checkShape(root)).toEqual({
    exitCode: 1,
    errors: [
      "lib/dynamic.ts: lib must not import application or tooling code modules/alpha/private.ts",
      "lib/equals.ts: lib must not import application or tooling code scripts/task.ts",
      "lib/locked.ts: module checker could not read the source",
      "lib/type.ts: lib must not import application or tooling code modules/alpha/main.ts",
      "modules/beta/main.ts: imports private module file modules/alpha/private.ts; import modules/alpha/main.ts",
      "modules/beta/main.ts: main.ts must export exactly one variable statement",
      "modules/flat.ts: production files must be inside a feature module",
      "modules/gamma/main.ts: every module requires one public interface",
      "stray.ts: production TypeScript must live in modules/<feature>/ or lib/",
      "tools/other.ts: production TypeScript must live in modules/<feature>/ or lib/",
    ],
  });
});
