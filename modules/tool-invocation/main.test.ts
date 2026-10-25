import { expect, test } from "bun:test";
import { ToolInvocation } from "./main.ts";

test("passes exact input and arguments and reports the tool's exit and output", async () => {
  const result = await ToolInvocation.run({
    tool: process.execPath,
    args: [
      "-e",
      'process.stdout.write((await Bun.stdin.text()) + Bun.argv[1]); process.stderr.write("failed"); process.exitCode = 3;',
      "a b",
    ],
    input: "exact\n",
    timeoutMs: 5_000,
  });
  expect(result).toEqual({
    status: "completed",
    exitCode: 3,
    stdout: "exact\na b",
    stderr: "failed",
  });
});

test("reports an unavailable tool without running a command", async () => {
  const tool = `operator-missing-${crypto.randomUUID()}`;
  expect(await ToolInvocation.run({ tool, args: [], timeoutMs: 100 })).toEqual({
    status: "unavailable",
    tool,
    detail: `${tool} is not on the path, so nothing was requested.`,
  });
});

test("keeps a timed-out external operation uncertain", async () => {
  const result = await ToolInvocation.run({
    tool: process.execPath,
    args: ["-e", "await Bun.sleep(10_000)"],
    timeoutMs: 100,
  });
  expect(result.status).toBe("no-answer");
  expect(result.status === "no-answer" && result.detail).toContain("SIGTERM");
});
