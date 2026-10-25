import { expect, test } from "bun:test";
import { lintProject } from "../check.ts";

const check = lintProject();

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
  "modules/release-publish/fake-gh.ts",
  "modules/release-publish/fake-jsr-client.ts",
])("accepts only the explicit environment owner and fake-tool exemption %s", async (file) => {
  expect(
    (await check("export const probe = process.env.PATH;", { path: file })).codes,
  ).not.toContain("operator(env-through-schema)");
});

test("does not exempt a fake by basename or exempt ordinary tests", async () => {
  for (const file of ["lib/fake-gh.ts", "lib/environment.test.ts"]) {
    expect((await check("export const probe = process.env.PATH;", { path: file })).codes).toContain(
      "operator(env-through-schema)",
    );
  }
});
