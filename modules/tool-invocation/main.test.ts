import { afterEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no chmod, temporary-directory, or real-path API.
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { ToolInvocation } from "./main.ts";

const modulePath = new URL("./main.ts", import.meta.url).pathname;
afterEach(() => {
  mock.restore();
});

async function temporaryFolder() {
  return realpath(await mkdtemp(path.join(tmpdir(), "operator-tool-")));
}

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
  expect(result).toEqual({
    status: "no-answer",
    detail: `${process.execPath} -e ended on SIGTERM with no answer.`,
  });
});

test("names a timed-out tool that had no arguments", async () => {
  const folder = await temporaryFolder();
  try {
    const tool = `${folder}/silent`;
    await Bun.write(tool, `#!${process.execPath}\nawait Bun.sleep(10_000);\n`);
    await chmod(tool, 0o755);
    expect(await ToolInvocation.run({ tool, args: [], timeoutMs: 100 })).toEqual({
      status: "no-answer",
      detail: `${tool}  ended on SIGTERM with no answer.`,
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("finds the tool on the validated environment path", async () => {
  const folder = await temporaryFolder();
  try {
    const tool = `operator-probe-${crypto.randomUUID()}`;
    await Bun.write(`${folder}/${tool}`, `#!${process.execPath}\nprocess.stdout.write("found");\n`);
    await chmod(`${folder}/${tool}`, 0o755);
    spyOn(Environment, "read").mockReturnValue({ ...Environment.read(), PATH: folder });
    expect(await ToolInvocation.run({ tool, args: [], timeoutMs: 5_000 })).toEqual({
      status: "completed",
      exitCode: 0,
      stdout: "found",
      stderr: "",
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("gives a tool no input stream when the call has no input", async () => {
  const result = await ToolInvocation.run({
    tool: process.execPath,
    args: ["-e", 'process.stdout.write(String(require("node:fs").fstatSync(0).isFIFO()))'],
    timeoutMs: 5_000,
  });
  expect(result).toMatchObject({ status: "completed", stdout: "false" });
});

test("does not keep the caller open while a detached process runs", async () => {
  const folder = await temporaryFolder();
  try {
    const started = performance.now();
    const caller = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { ToolInvocation } = await import(${JSON.stringify(modulePath)}); console.log(ToolInvocation.detach({ tool: process.execPath, args: ["-e", "await Bun.sleep(10_000)"], cwd: ${JSON.stringify(folder)} }));`,
      ],
      { env: Environment.child(), stdout: "pipe", stderr: "pipe" },
    );
    const [code, output] = await Promise.all([caller.exited, new Response(caller.stdout).text()]);
    expect(code).toBe(0);
    // The detached process sleeps for ten seconds, so a caller that waits for it ends far later.
    expect(performance.now() - started).toBeLessThan(5000);
    process.kill(Number(output.trim()));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("detaches a process in its own group that runs in the given folder with the child environment", async () => {
  const folder = await temporaryFolder();
  try {
    const pid = ToolInvocation.detach({
      tool: process.execPath,
      args: [
        "-e",
        `await Bun.write("record.json", JSON.stringify({ pid: process.pid, path: process.env.PATH, stdin: await Bun.stdin.text() })); await Bun.write("done", ""); await Bun.sleep(2000);`,
      ],
      cwd: folder,
    });
    const done = Bun.file(`${folder}/done`);
    for (let attempt = 0; attempt < 250 && !(await done.exists()); attempt++) await Bun.sleep(20);
    expect(await Bun.file(`${folder}/record.json`).json()).toEqual({
      pid,
      path: Environment.read().PATH,
      stdin: "",
    });
    const group = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)])
      .stdout.toString()
      .trim();
    expect(group).toBe(String(pid));
    process.kill(pid);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
