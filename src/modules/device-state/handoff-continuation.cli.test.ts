import { expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";

async function captureContinuationOutput(
  stream: ReadableStream<Uint8Array>,
  channel: string,
  emit: (line: string) => void = console.error,
) {
  let output = "";
  let pending = "";
  let remaining = 8192;
  let phases = 0;
  const decoder = new TextDecoder();
  function report(line: string) {
    // Reserve 80 phase records for the 38 scenarios, independent of noisy tool output.
    if (line.startsWith("[continuation] ")) {
      if (phases < 80) emit(line.slice(0, 512));
      phases++;
    } else if (remaining > 0) {
      const record = `[continuation:${channel}] ${new Date().toISOString()} ${line}`.slice(
        0,
        Math.min(512, remaining - 1),
      );
      emit(record);
      remaining -= record.length + 1;
    }
  }
  for await (const bytes of stream) {
    const chunk = decoder.decode(bytes, { stream: true });
    // Keep the original complete assertion output; only incremental diagnostics are capped.
    output += chunk;
    const lines = `${pending}${chunk}`.split("\n");
    pending = (lines.pop() ?? "").slice(0, 512);
    for (const line of lines) report(line.slice(0, 512));
  }
  const final = decoder.decode();
  output += final;
  pending += final;
  if (pending) report(pending);
  return output;
}

test("continuation diagnostics survive a stopped isolated subprocess with bounded noisy output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "operator-continuation-diagnostics-"));
  const progress = Bun.fileURLToPath(
    new URL("../operator-cli/continuation-diagnostics-fixture.ts", import.meta.url),
  );
  const fixture = `${root}/control.test.ts`;
  await Bun.write(
    fixture,
    `import { test } from "bun:test";
import { continuationProgress } from ${JSON.stringify(progress)};
test("completed-control", () => {
  continuationProgress("start", "completed-control");
  console.log("stdout-control\\n" + "o".repeat(100000));
  console.error("stderr-control\\n" + "n".repeat(100000));
  continuationProgress("complete", "completed-control");
});
test("stopped-control", async () => {
  continuationProgress("start", "stopped-control");
  await new Promise(() => {});
}, 60000);
`,
  );
  const child = Bun.spawn([process.execPath, "test", "--isolate", "--dots", fixture], {
    env: Environment.child({ BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
    killSignal: "SIGTERM",
  });
  const diagnostics: string[] = [];
  function retain(line: string) {
    diagnostics.push(line);
    if (line.includes(" start stopped-control") && child.exitCode === null) child.kill("SIGKILL");
  }
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      captureContinuationOutput(child.stdout, "stdout", retain),
      captureContinuationOutput(child.stderr, "stderr", retain),
    ]);
    expect(child.signalCode).toBe("SIGKILL");
    expect(code).not.toBe(0);
    const phases = diagnostics.filter((line) => line.startsWith("[continuation] "));
    expect(phases).toHaveLength(3);
    expect(phases[0]).toMatch(
      /^\[continuation\] \d{4}-\d\d-\d\dT[\d:.]+Z \+\d+\.\dms start completed-control$/,
    );
    expect(phases[1]).toMatch(
      /^\[continuation\] \d{4}-\d\d-\d\dT[\d:.]+Z \+\d+\.\dms complete completed-control$/,
    );
    expect(phases[2]).toMatch(
      /^\[continuation\] \d{4}-\d\d-\d\dT[\d:.]+Z \+\d+\.\dms start stopped-control$/,
    );
    expect(diagnostics.every((line) => line.length <= 512)).toBe(true);
    expect(diagnostics.join("\n").length).toBeLessThanOrEqual(2 * (8192 + 80 * 513));
    expect(diagnostics.join("\n")).toContain("stdout-control");
    expect(diagnostics.join("\n")).toContain("stderr-control");
    expect(stdout).toContain("o".repeat(100000));
    expect(stderr).toContain("n".repeat(100000));
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
