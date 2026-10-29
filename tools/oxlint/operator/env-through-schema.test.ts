import { expect, test } from "bun:test";
import { lintProject } from "../check.ts";

const check = lintProject();

// A binding cycle comes first, so a rule that never returns hits the lint time limit early.
test("a binding cycle is not an environment host", async () => {
  const result = await check(
    "const loopA = loopB; const loopB = loopA; export const five = loopA.env;",
  );
  expect(result.codes).not.toContain("operator(env-through-schema)");
});

test("the diagnostic points to guidance that explains the environment owner", async () => {
  const result = await check("export const value = process.env.PATH;");
  expect(result.stdout).toContain("deep-modules/server-state.md");
  const topic = await Bun.file(
    new URL("../../../skills/deep-modules/server-state.md", import.meta.url),
  ).text();
  for (const term of [
    "operator/env-through-schema",
    "Environment.read()",
    "Environment.child(overrides)",
    "isolated",
    "parent environment",
  ])
    expect(topic).toContain(term);
});

test.each([
  "process.env.PATH",
  "Bun.env.PATH",
  "import.meta.env.PATH",
  "process['env'].PATH",
  "globalThis.process.env.PATH",
  "globalThis.Bun.env.PATH",
])("rejects raw environment access %s", async (expression) => {
  expect((await check(`export const value = ${expression};`)).codes).toContain(
    "operator(env-through-schema)",
  );
});

test.each([
  "const { env } = process; export const value = env.PATH;",
  'import { env } from "node:process"; export const value = env.PATH;',
  'import system from "node:process"; export const value = system.env.PATH;',
  "const system = process; export const value = system.env.PATH;",
  'process.env.PATH = "/wrong";',
])("rejects aliases and parent environment mutation %s", async (source) => {
  expect((await check(source)).codes).toContain("operator(env-through-schema)");
});

test("accepts the validated boundary and shadowed application names", async () => {
  const result = await check(
    'import { Environment } from "../modules/environment/main.ts"; export const path = Environment.read().PATH; export function read(process: { env: string }) { return process.env; }',
  );
  expect(result.codes).toEqual([]);
});

test.each([
  "modules/environment/main.ts",
  "modules/release-publish/gh-fixture.ts",
  "modules/release-publish/jsr-client-fixture.ts",
])("accepts only the explicit environment owner and fake-tool exemption %s", async (file) => {
  expect(
    (await check("export const probe = process.env.PATH;", { path: file })).codes,
  ).not.toContain("operator(env-through-schema)");
});

test("does not exempt a fake by basename or exempt ordinary tests", async () => {
  for (const file of ["lib/gh-fixture.ts", "lib/environment.test.ts"]) {
    expect((await check("export const probe = process.env.PATH;", { path: file })).codes).toContain(
      "operator(env-through-schema)",
    );
  }
});

const rule = "operator(env-through-schema)";

async function flagged(lines: string[]): Promise<number[]> {
  const result = await check(lines.join("\n"));
  return result.findings
    .filter((finding) => finding.endsWith(` ${rule}`))
    .map((finding) => Number.parseInt(finding, 10));
}

test("finds environment hosts through imports, globals, and const aliases only", async () => {
  // Each import line is followed by the probe's blank line, so the other cases start on line 11.
  expect(
    await flagged([
      'import bare from "process";',
      'import system from "node:process";',
      'import { env as quotedEnv } from "./other.ts";',
      'import * as foreign from "./other.ts";',
      'import { Environment } from "../modules/environment/main.ts";',
      "interface system {}",
      "export const one = bare.env;",
      "export const two = system.env;",
      "export const three = settings.process.env;",
      "export const four = Environment.read().env;",
      "export function target() { return new.target.env; }",
      "export function given(holder) { return holder.env; }",
      "const loopA = loopB; const loopB = loopA; export const five = loopA.env;",
      "export const six = foreign.env;",
      "export const seven = process.argv;",
      "export const eight = process[String(1)];",
      "export const nine = import.meta.env;",
      "export const ten = globalThis.process.env;",
    ]),
  ).toEqual([12, 13, 22, 23]);
});

test("finds a destructured env by name or literal key, in declarations and assignments", async () => {
  expect(
    await flagged([
      "const { env: named } = process;",
      'const { "env": literal } = process;',
      'const { ["env"]: computed } = process;',
      "const { env: first, argv } = process;",
      "const { argv: other } = process;",
      'const { "argv": quoted } = process;',
      "const { ...rest } = process;",
      "for (const { env: item } of [process]) {}",
      "let assigned; ({ env: assigned } = process);",
      "export const all = [named, literal, computed, first, argv, other, quoted, rest, assigned];",
    ]),
  ).toEqual([1, 2, 3, 4, 9]);
});

test("finds an env import from the process module by any name", async () => {
  // Each import line is followed by the probe's blank line.
  expect(
    await flagged([
      'import { env } from "node:process";',
      'import { env as other } from "process";',
      'import { "env" as quoted } from "node:process";',
      'import { env as both, argv } from "node:process";',
      'import { argv as args } from "node:process";',
      'import processDefault from "node:process";',
      'import { env as foreign } from "./other.ts";',
      "export const all = [env, other, quoted, both, argv, args, processDefault, foreign];",
    ]),
  ).toEqual([1, 3, 5, 7]);
});

test("the finding names the environment owner and its guide", async () => {
  const result = await check("export const value = process.env.PATH;");
  expect(result.stdout).toContain(
    "Read validated values from Environment. Supply child environments, never change the parent. See deep-modules/server-state.md.",
  );
});
