import { afterAll, expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../modules/environment/main.ts";

const script = Bun.fileURLToPath(new URL("./test-watchdog.ts", import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), "operator-test-watchdog-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function watch(args: string[]) {
  const child = Bun.spawn([process.execPath, script, ...args], {
    cwd: path.dirname(path.dirname(script)),
    env: Environment.child(),
    stdout: "pipe",
    stderr: "pipe",
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

test("a run with no test progress stops with its own processes named and killed", async () => {
  const stalled = [`${root}/stalled-one.test.ts`, `${root}/stalled-two.test.ts`];
  for (const file of stalled)
    await Bun.write(
      file,
      `import { test } from "bun:test";
test("blocks its worker", () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0));`,
    );
  const startedAt = Date.now();
  const { code, stderr } = await watch(["--watchdog-silence=2", ...stalled]);
  expect(code).toBe(124);
  expect(Date.now() - startedAt).toBeLessThan(15000);
  expect(stderr).toContain("test-watchdog: no test progress for ");
  const listed = (stderr.split("test-watchdog: processes of this run:\n")[1] ?? "")
    .split("\ntest-watchdog:")[0]
    ?.split("\n")
    .slice(1);
  expect(listed?.some((line) => line.includes("--test-worker"))).toBe(true);
  const pids = listed?.map((line) => Number(line.trim().split(/\s+/)[0])) ?? [];
  expect(pids.length).toBeGreaterThan(1);
  expect(pids.filter(alive)).toEqual([]);
}, 30000);

test("a signal stops the whole run and keeps its own exit status", async () => {
  const stalled = [`${root}/signalled-one.test.ts`, `${root}/signalled-two.test.ts`];
  for (const file of stalled)
    await Bun.write(
      file,
      `import { test } from "bun:test";
test("blocks its worker", () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0));`,
    );
  const child = Bun.spawn([process.execPath, script, "--watchdog-silence=60", ...stalled], {
    cwd: path.dirname(path.dirname(script)),
    env: Environment.child(),
    stdout: "pipe",
    stderr: "pipe",
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
}, 30000);

test("a finished run keeps the bun test output and exit code", async () => {
  const failing = `${root}/failing.test.ts`;
  await Bun.write(
    failing,
    `import { expect, test } from "bun:test";
test("passes", () => expect(1).toBe(1));
test("deliberately fails", () => expect(1).toBe(2));`,
  );
  const { code, stdout, stderr } = await watch([failing]);
  expect(code).toBe(1);
  expect(stdout + stderr).toContain("(fail) deliberately fails");
  expect(stderr).not.toContain("test-watchdog:");
}, 30000);

test("refuses a silence limit that is not a positive whole number of seconds", async () => {
  for (const limit of ["0", "-1", "1.5", "soon"])
    expect(await watch([`--watchdog-silence=${limit}`])).toEqual({
      code: 2,
      stdout: "",
      stderr: "test-watchdog: --watchdog-silence=<seconds> must be a positive integer.\n",
    });
});
