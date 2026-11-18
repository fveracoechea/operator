import { expect, test } from "bun:test";
import { Environment } from "../environment/main.ts";

test("one-off source lifecycle through the isolated CLI seam", async () => {
  const root = Bun.fileURLToPath(new URL("../../../", import.meta.url));
  const child = Bun.spawn(
    [
      process.execPath,
      `${root}/tools/test-watchdog.ts`,
      `${root}/src/modules/operator-cli/run.one-off.test.ts`,
    ],
    {
      cwd: root,
      env: Environment.child({ BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
  expect(`${stdout}\n${stderr}`).toContain("20 pass");
}, 120000);
