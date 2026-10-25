import { afterAll, expect, test } from "bun:test";
// Bun has no temporary directory, directory creation, or recursive removal API.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "operator-lint-location-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
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
  expect((await check("export const value = 1;")).exitCode).toBe(0);
  const directories = await Array.fromAsync(new Bun.Glob("operator-lint-*").scan({ cwd: ${JSON.stringify(temporary)}, onlyFiles: false }));
  expect(directories.length).toBe(1);
});\n`,
  );
  const child = Bun.spawn([process.execPath, "test", "--isolate", entry], {
    cwd: directory,
    env: { ...process.env, TMPDIR: temporary },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
});
