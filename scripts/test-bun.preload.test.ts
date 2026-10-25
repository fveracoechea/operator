import { expect, test } from "bun:test";
import { Environment } from "../modules/environment/main.ts";

test("the preload refuses a disabled test-root guard without changing the parent", async () => {
  const child = Bun.spawn([process.execPath, import.meta.dir + "/test-bun.preload.ts"], {
    env: Environment.child({ NODE_ENV: "production" }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).toBe(1);
  expect(stderr).toContain("Tests require NODE_ENV=test");
  expect(Environment.read().NODE_ENV).toBe("test");
});
