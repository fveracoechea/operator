import { expect, test } from "bun:test";
import { Environment } from "../src/modules/environment/main.ts";

/** Keep mutation's owning beside-tests on the approved isolated-device CLI seam. */
export function customKindCliTest(scenario: "settings" | "dispatch") {
  test(`person-defined kinds through the ${scenario} CLI seam`, async () => {
    const root = Bun.fileURLToPath(new URL("../", import.meta.url));
    const child = Bun.spawn(
      [
        process.execPath,
        `${root}/tools/test-watchdog.ts`,
        `${root}/src/modules/operator-cli/run.${scenario}.test.ts`,
        "-t",
        "person-defined|dispatch with a kind fixes|cannot be plainly dispatched|a launch keeps its kind snapshot",
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
  }, 120_000);
}
