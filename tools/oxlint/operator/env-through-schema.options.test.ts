import { afterAll, expect, test } from "bun:test";
// Bun has no temporary directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "operator-env-options-"));
const oxlint = path.join(import.meta.dir, "../../../node_modules/oxlint/bin/oxlint");
afterAll(async () => {
  await rm(root, { recursive: true });
});

// Lints one probe with only this rule, configured with the given rule entry.
async function lint(entry: unknown[] | string): Promise<{ code: number; output: string }> {
  const directory = await mkdtemp(path.join(root, "case-"));
  await Bun.write(
    path.join(directory, ".oxlintrc.json"),
    JSON.stringify({
      plugins: [],
      categories: { correctness: "off" },
      jsPlugins: [{ name: "operator", specifier: path.join(import.meta.dir, "index.ts") }],
      rules: { "operator/env-through-schema": entry },
    }),
  );
  await Bun.write(path.join(directory, "probe.ts"), "export const value = process.env.PATH;\n");
  const child = Bun.spawn([process.execPath, oxlint, "--format", "json", "probe.ts"], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: stdout + stderr };
}

test("without options the rule allows no file", async () => {
  const result = await lint("error");
  expect(result.code).toBe(1);
  expect(result.output).toContain('"code": "operator(env-through-schema)"');
});

test("a listed file, relative to the working folder, is allowed", async () => {
  const result = await lint(["error", { allowFiles: ["probe.ts"] }]);
  expect(result.code).toBe(0);
  expect(result.output).not.toContain("operator(env-through-schema)");
});

test.each<unknown>([
  { allowFiles: "probe.ts" },
  { allowFiles: [1] },
  { allowFiles: [], extra: true },
  ["probe.ts"],
])("the configuration refuses malformed options %j", async (options) => {
  const result = await lint(["error", options]);
  expect(result.code).not.toBe(0);
  expect(result.output).toContain(
    "Options validation failed for rule 'operator/env-through-schema'",
  );
});
