import { afterAll, expect, test } from "bun:test";
import { Environment } from "../../modules/environment/main.ts";
// Bun has no temporary directory, directory creation, or recursive removal API.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { lintProject } from "./check.ts";

const root = await mkdtemp(path.join(tmpdir(), "operator-lint-location-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const check = lintProject();

test("reports each probe finding by line, and separates the probe from extra files", async () => {
  const result = await check(
    'export const first = 1;\n\nexport const value: unknown = Reflect.get({}, "id");\n',
    { files: { "lib/lint-extra.ts": 'export const extra: unknown = Reflect.get({}, "id");\n' } },
  );

  expect(result.exitCode).toBe(1);
  expect(result.findings).toEqual(["3 anti-slop(no-reflect-get)"]);
  expect(result.codes).toEqual(["anti-slop(no-reflect-get)", "anti-slop(no-reflect-get)"]);
  expect(result.stdout).toContain("lint-fixes/parse-at-the-boundary.md");
});

test("puts the policy's blank line after one-line imports and passes clean code", async () => {
  const result = await check('import { z } from "zod";export const name = z.string();');

  expect({ exitCode: result.exitCode, codes: result.codes, stderr: result.stderr }).toEqual({
    exitCode: 0,
    codes: [],
    stderr: "",
  });
});

test("removes a new probe and restores a replaced file before the next probe", async () => {
  await check('export const probe: string = "probe";\n', { path: "lib/lint-probe-a.ts" });
  await check("export const replaced = 1;\n", { path: "lib/sha256.ts" });
  const consumer = [
    'import { probe } from "./lint-probe-a.ts";',
    'import { sha256 } from "./sha256.ts";',
    "export const text: string = probe;",
    'export const digest: string = sha256("a");',
  ].join("\n");

  // Line 5 reads the removed probe through an unresolved import. Line 6 reads the restored file.
  expect((await check(`${consumer}\n`)).findings).toEqual(["5 typescript(no-unsafe-assignment)"]);
});

test("lint scenarios use the supplied temporary root rather than a harness-only directory", async () => {
  const directory = await mkdtemp(path.join(root, "case-"));
  const temporary = path.join(directory, "tmp");
  await mkdir(temporary);
  const entry = path.join(directory, "location.test.ts");
  await Bun.write(
    entry,
    `import { expect, test } from "bun:test";
import { lintProject } from ${JSON.stringify(path.join(import.meta.dir, "check.ts"))};
const check = lintProject();
test("lint in the supplied root", async () => {
  // Model a CI lint call that exceeds Bun's default five-second test budget.
  await Bun.sleep(5100);
  expect((await check("export const value = 1;")).exitCode).toBe(0);
  const directories = await Array.fromAsync(new Bun.Glob("operator-lint-*").scan({ cwd: ${JSON.stringify(temporary)}, onlyFiles: false }));
  expect(directories.length).toBe(1);
});\n`,
  );
  const child = Bun.spawn([process.execPath, "test", "--isolate", "--timeout=30000", entry], {
    cwd: directory,
    env: Environment.child({ TMPDIR: temporary }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
  // The finished file removes its checkout.
  expect(
    await Array.fromAsync(
      new Bun.Glob("operator-lint-*").scan({ cwd: temporary, onlyFiles: false }),
    ),
  ).toEqual([]);
});
