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
  // The source frame quotes the throw line, so only the reported error line proves the reason.
  expect(stderr).toMatch(/^error: Tests require NODE_ENV=test /m);
  expect(Environment.read().NODE_ENV).toBe("test");
});
