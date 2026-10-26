import { afterAll, expect, test } from "bun:test";
// Bun has no temporary-directory, chmod, or recursive removal API.
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";

const root = await mkdtemp(path.join(tmpdir(), "readiness-test-isolation-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("direct readiness tests cannot request ambient GitHub authentication", async () => {
  const sentinel = `${root}/ambient-authentication`;
  await Bun.write(
    `${root}/tools/gh`,
    `#!${process.execPath}\nawait Bun.write(${JSON.stringify(sentinel)}, "unexpected authentication call");`,
    { createPath: true },
  );
  await chmod(`${root}/tools/gh`, 0o755);
  const child = Bun.spawn([process.execPath, "run", "test", "modules/readiness/main.test.ts"], {
    cwd: Bun.fileURLToPath(new URL("../../", import.meta.url)),
    env: Environment.child({
      HOME: `${root}/ambient-home`,
      XDG_CONFIG_HOME: `${root}/ambient-config`,
      XDG_STATE_HOME: `${root}/ambient-state`,
      PATH: `${root}/tools:${Environment.read().PATH}`,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, `${stdout}${stderr}`).toBe(0);
  expect(await Bun.file(sentinel).exists()).toBe(false);
});
