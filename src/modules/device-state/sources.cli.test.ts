import { expect, test } from "bun:test";
import { Environment } from "../environment/main.ts";

test("handoff source facts and pruning through the isolated CLI seam", async () => {
  const root = Bun.fileURLToPath(new URL("../../../", import.meta.url));
  const child = Bun.spawn(
    [
      process.execPath,
      `${root}/tools/test-watchdog.ts`,
      `${root}/src/modules/operator-cli/run.internal-review.test.ts`,
      `${root}/src/modules/operator-cli/run.internal-review-guards.test.ts`,
      "--test-name-pattern",
      "automatic kind handoff preserves distinct|a running handoff shows|stopped handoff recovery|pruning an ended assignment",
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
  expect(`${stdout}\n${stderr}`).toContain("\n5 pass\n");
}, 180000);
