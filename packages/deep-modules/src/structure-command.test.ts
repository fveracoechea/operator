import { expect, test } from "bun:test";

test("the executable adapter forwards invalid arguments to the shared command", async () => {
  const child = Bun.spawn(
    [process.execPath, new URL("./structure-command.ts", import.meta.url).pathname, "--invalid"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).toBe(2);
  expect(stderr).toContain("usage: deep-modules-structure");
});
