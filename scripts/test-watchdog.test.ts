import { afterAll, expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../modules/environment/main.ts";

const script = Bun.fileURLToPath(new URL("./test-watchdog.ts", import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), "operator-test-watchdog-"));
afterAll(async () => {
  // A broken watchdog can leave blocked workers behind. Only this file's processes name the root.
  Bun.spawnSync(["pkill", "-9", "-f", root]);
  await rm(root, { recursive: true, force: true });
});

async function watch(args: string[], cwd = root) {
  // The run starts in the test root, so a file filter cannot reach the repository's own tests.
  // The time limit stops a watchdog that never exits before the test's own limit.
  const child = Bun.spawn([process.execPath, script, ...args], {
    cwd,
    env: Environment.child(),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
    killSignal: "SIGKILL",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function pids(output: string) {
  return output.trim().split("\n").filter(Boolean).map(Number);
}

function alive(pid: number) {
  return (
    Bun.spawnSync(["ps", "-o", "pid=", "-p", String(pid)])
      .stdout.toString()
      .trim() !== ""
  );
}

// A terminal on the watchdog's own output keeps bun test's colors through the pipe.
test.skipIf(Bun.which("script") === null)(
  "a run on a terminal keeps colored bun test output",
  async () => {
    const passing = `${root}/colored.test.ts`;
    await Bun.write(
      passing,
      `import { expect, test } from "bun:test";\ntest("passes", () => expect(1).toBe(1));`,
    );
    const command = [process.execPath, script, passing];
    // BSD script takes the command after the log file. util-linux script takes one command string.
    const terminal =
      process.platform === "darwin"
        ? ["script", "-q", "/dev/null", ...command]
        : ["script", "-qec", command.map((part) => `'${part}'`).join(" "), "/dev/null"];
    const child = Bun.spawn(terminal, {
      cwd: root,
      env: Environment.child(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
      killSignal: "SIGKILL",
    });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(0);
    expect(stdout).toContain("\u001b[");
  },
  30_000,
);

test("a run with no test progress stops with its own processes named and killed", async () => {
  const stalled = [`${root}/stalled-one.test.ts`, `${root}/stalled-two.test.ts`];
  for (const file of stalled)
    await Bun.write(
      file,
      `import { test } from "bun:test";
test("blocks its worker", () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0));`,
    );
  const startedAt = Date.now();
  const { code, stderr } = await watch(["--watchdog-silence=4", ...stalled]);
  expect(code).toBe(124);
  expect(Date.now() - startedAt).toBeLessThan(25_000);
  // The report names the silence and the run time in whole seconds, once.
  const [, silent, total] =
    /test-watchdog: no test progress for (\d+)s after (\d+)s\. Stopping bun test\.\n/.exec(
      stderr,
    ) ?? [];
  expect(Number(silent)).toBeGreaterThanOrEqual(4);
  expect(Number(silent)).toBeLessThanOrEqual(Number(total));
  expect(Number(total)).toBeLessThan(25);
  expect(stderr.split("no test progress for ")).toHaveLength(2);
  expect(stderr).toContain(
    "\ntest-watchdog: a silent worker at 0% CPU matches the open Bun worker deadlock oven-sh/bun#39987.\ntest-watchdog: processes of this run:\n",
  );
  const resources = stderr.split(
    "\ntest-watchdog: working directories, sockets, and pipes of this run:\n",
  )[1];
  const resourceLines = resources?.trimEnd().split("\n") ?? [];
  // lsof lists working directories, and nothing but the selected kinds.
  // A busy machine can stall before every worker starts, so one directory is enough.
  expect(resourceLines.filter((line) => / cwd /.test(line)).length).toBeGreaterThan(0);
  // One open file per line.
  expect(resourceLines.length).toBeGreaterThan(1);
  for (const line of resourceLines)
    expect(line.match(/ (cwd|IPv4|IPv6|unix|FIFO|PIPE) /g)).toHaveLength(1);
  expect(resourceLines.filter((line) => !/ (cwd|IPv4|IPv6|unix|FIFO|PIPE) /.test(line))).toEqual(
    [],
  );
  const listed = (stderr.split("test-watchdog: processes of this run:\n")[1] ?? "")
    .split("\ntest-watchdog:")[0]
    ?.split("\n")
    .slice(1);
  expect(listed?.some((line) => line.includes("--test-worker"))).toBe(true);
  // The watchdog passes the selected files to bun test.
  expect(listed?.some((line) => line.includes(stalled[1] ?? "missing"))).toBe(true);
  expect(listed).not.toContain("");
  const pids = listed?.map((line) => Number(line.trim().split(/\s+/)[0])) ?? [];
  expect(pids.length).toBeGreaterThan(1);
  expect(pids.filter(alive)).toEqual([]);
}, 30_000);

test("a signal stops the whole run and keeps its own exit status", async () => {
  const stalled = [`${root}/signalled-one.test.ts`, `${root}/signalled-two.test.ts`];
  for (const file of stalled)
    await Bun.write(
      file,
      `import { test } from "bun:test";
test("blocks its worker", () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0));`,
    );
  const child = Bun.spawn([process.execPath, script, "--watchdog-silence=60", ...stalled], {
    cwd: root,
    env: Environment.child(),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
    killSignal: "SIGKILL",
  });
  let run: number[] = [];
  for (let attempt = 0; attempt < 100 && run.length < 3; attempt++) {
    await Bun.sleep(100);
    const runner = pids(Bun.spawnSync(["pgrep", "-f", stalled[0] ?? ""]).stdout.toString());
    run = [
      ...runner,
      ...runner.flatMap((pid) =>
        pids(Bun.spawnSync(["pgrep", "-P", String(pid)]).stdout.toString()),
      ),
    ];
  }
  expect(run.length).toBeGreaterThanOrEqual(3);
  child.kill("SIGTERM");
  expect(await child.exited).toBe(143);
  expect(run.filter(alive)).toEqual([]);
}, 30_000);

test("a finished run keeps the bun test output and exit code", async () => {
  // An own folder without blocked files, so a run that ignores the file filter ends fast.
  const folder = `${root}/finished`;
  const failing = `${folder}/failing.test.ts`;
  await Bun.write(
    failing,
    `import { expect, test } from "bun:test";
test("passes", () => expect(1).toBe(1));
test("deliberately fails", () => expect(1).toBe(2));`,
  );
  await Bun.write(
    `${folder}/unselected.test.ts`,
    `import { test } from "bun:test";\ntest("not selected", () => {});`,
  );
  const { code, stdout, stderr } = await watch([failing], folder);
  expect(code).toBe(1);
  expect(stdout + stderr).toContain("(fail) deliberately fails");
  expect(stdout + stderr).toContain("Ran 2 tests across 1 file.");
  expect(stderr).not.toContain("test-watchdog:");
}, 30_000);

test("refuses a silence limit that is not a positive whole number of seconds", async () => {
  const refused = {
    code: 2,
    stdout: "",
    stderr: "test-watchdog: --watchdog-silence=<seconds> must be a positive integer.\n",
  };
  expect(
    await Promise.all(
      ["0", "-1", "1.5", "soon"].map((limit) => watch([`--watchdog-silence=${limit}`])),
    ),
  ).toEqual([refused, refused, refused, refused]);
}, 30_000);

test("accepts a one-second silence limit and stops a silent run with it", async () => {
  // A blocked worker, so a slow start on a busy machine cannot change the result.
  const stalled = `${root}/one-second.test.ts`;
  await Bun.write(
    stalled,
    `import { test } from "bun:test";
test("blocks its worker", () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0));`,
  );
  const { code, stderr } = await watch(["--watchdog-silence=1", stalled]);
  expect({ code, report: /no test progress for \d+s after/.test(stderr) }).toEqual({
    code: 124,
    report: true,
  });
}, 30_000);

test("a stalled run without lsof still names its processes and says lsof is missing", async () => {
  const stalled = `${root}/no-lsof.test.ts`;
  await Bun.write(
    stalled,
    `import { test } from "bun:test";
test("blocks its worker", () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0));`,
  );
  // Only ps is on PATH, so the watchdog cannot find lsof.
  const tools = await mkdtemp(path.join(root, "tools-"));
  const ps = Bun.which("ps");
  expect(ps).not.toBeNull();
  await symlink(ps ?? "", path.join(tools, "ps"));
  const child = Bun.spawn([process.execPath, script, "--watchdog-silence=1", stalled], {
    cwd: root,
    env: Environment.child({ PATH: tools }),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
    killSignal: "SIGKILL",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).toBe(124);
  expect(stderr).toEndWith(
    "test-watchdog: working directories, sockets, and pipes of this run:\nlsof is not available.\n",
  );
}, 30_000);
