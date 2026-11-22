import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
// Bun has no temporary-directory, symbolic-link, or recursive removal API.
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { z } from "zod";
import type { MutationEvent } from "./mutation-run.ts";

setDefaultTimeout(20_000);
const root = await mkdtemp("/tmp/opencode/mutation-worker-");
afterAll(async () => rm(root, { recursive: true, force: true }));

async function result(child: Bun.Subprocess<"pipe", "pipe", "pipe">, deadline = 1000) {
  const timer = setTimeout(() => process.kill(-child.pid, "SIGKILL"), deadline);
  try {
    return await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("worker refuses a closed admission pipe without executing a unit", async () => {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/mutation-worker.ts`], {
    detached: true,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await child.stdin.end();
  const [code, stdout, stderr] = await result(child);
  expect(code).toBe(3);
  expect(stdout).toBe("");
  expect(stderr).toContain("admission incomplete");
});

test("worker reads complete large UTF-8 admission rather than treating a pipe chunk as a message", async () => {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/mutation-worker.ts`], {
    detached: true,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const completion = result(child);
  function encode(source: string) {
    return new TextEncoder().encode(
      JSON.stringify({
        root,
        state: root,
        token: "unused",
        identity: "admitted",
        selected: {
          units: [{ source, name: "é.ts", tests: [], patterns: ["large.ts"] }],
          skipped: 0,
        },
      }) + "\n",
    );
  }

  // A full pipe forces the reader to start before the split UTF-8 byte is released.
  const payload = encode("x".repeat(1_048_575 - encode("").indexOf(195)));
  const boundary = payload.indexOf(195) + 1;
  expect(boundary).toBe(1_048_576);
  await child.stdin.write(payload.slice(0, boundary));
  await child.stdin.flush();
  await Bun.sleep(100);
  await child.stdin.write(payload.slice(boundary));
  await child.stdin.flush();
  const [code, stdout, stderr] = await completion;
  expect(code, stderr).toBe(2);
  expect(stdout).toContain("é.ts: untested. Add a direct beside-test.");
  expect(stdout).toContain("0 survivors, 1 untested, 0 incomplete");
});

test("native IPC publishes terminal evidence and waits for the owning command's receipt", async () => {
  const events: MutationEvent[] = [];
  const terminal = Promise.withResolvers<void>();
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/mutation-worker.ts`], {
    detached: true,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    ipc(event: MutationEvent) {
      events.push(event);
      if (event.type === "run-completed") terminal.resolve();
    },
  });
  const completion = result(child, 1500);
  await child.stdin.write(
    JSON.stringify({
      root: import.meta.dir,
      state: root,
      token: "ipc",
      identity: "admitted",
      json: true,
      selected: {
        units: [{ name: "missing.ts", source: "actual", patterns: ["missing.ts"], tests: [] }],
        skipped: 0,
      },
    }) + "\n",
  );
  await child.stdin.flush();
  const received = await Promise.race([
    terminal.promise.then(() => true),
    Bun.sleep(500).then(() => false),
  ]);
  expect(received).toBe(true);
  await Bun.sleep(100);
  expect(child.exitCode).toBe(null);
  child.send({});
  const [code, stdout, stderr] = await completion;
  expect(code, stderr).toBe(2);
  expect(stdout).toBe("");
  expect(stderr).toContain("missing.ts: untested.");
  expect(events.map((event) => event.type)).toEqual([
    "run-started",
    "unit-started",
    "unit-completed",
    "run-completed",
  ]);
  expect(events.at(-1)).toMatchObject({ runId: "ipc", state: { status: "failed" } });
});

test("worker persists a real completed engine result and honestly reports an engine error", async () => {
  const cwd = `${root}/engine`;
  await Bun.write(
    `${cwd}/package.json`,
    JSON.stringify({ scripts: { test: "bun test --isolate" } }),
  );
  const source = "export function count(n: number) { return n + 1; }\n";
  await Bun.write(`${cwd}/count.ts`, source);
  await symlink(`${import.meta.dir}/../node_modules`, `${cwd}/node_modules`);
  await Bun.write(
    `${cwd}/count.test.ts`,
    'import { expect, test } from "bun:test"; import { count } from "./count.ts"; test("exact", () => expect(count(1)).toBe(2));',
  );
  async function run(token: string, json = false, keepGoing = false) {
    const child = Bun.spawn([process.execPath, `${import.meta.dir}/mutation-worker.ts`], {
      cwd,
      detached: true,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const completion = result(child, 10_000);
    await child.stdin.write(
      JSON.stringify({
        root: cwd,
        state: root,
        token,
        identity: "admitted",
        json,
        keepGoing,
        selected: {
          units: [{ name: "count.ts", source, patterns: ["count.ts"], tests: ["./count.test.ts"] }],
          skipped: 0,
        },
      }) + "\n",
    );
    await child.stdin.flush();
    return completion;
  }

  const successful = await run("completed");
  expect(successful[0], successful[1] + successful[2]).toBe(0);
  const completed = z
    .object({
      unit: z.object({ name: z.string(), source: z.string() }),
      results: z.array(z.object({ status: z.string() })),
    })
    .parse(await Bun.file(`${root}/completed/count.ts.json`).json());
  expect(completed.unit).toEqual({ name: "count.ts", source });
  expect(completed.results.map((mutant) => mutant.status)).toEqual(["Killed", "Killed"]);
  await Bun.write(`${cwd}/count.test.ts`, "process.exit(19);");
  const failed = await run("failed");
  expect(failed[0]).toBe(3);
  expect(failed[1]).toEndWith(
    "Mutation summary: incomplete. See docs/agents/testing/mutation-testing.md.\n",
  );
  expect(failed[2]).toContain("Mutation execution incomplete:");
  expect(await Bun.file(`${root}/failed/count.ts.json`).exists()).toBe(false);
  const machine = await run("machine-failed", true);
  expect(machine[0]).toBe(3);
  expect(machine[1]).toBe("");
  expect(machine[2]).toContain(
    "Mutation summary: incomplete. See docs/agents/testing/mutation-testing.md.",
  );
  const diagnostic = await run("diagnostic-failed", true, true);
  expect(diagnostic[0]).toBe(3);
  expect(diagnostic[1]).toBe("");
  expect(diagnostic[2]).toContain("Mutation execution incomplete:");
  expect(diagnostic[2]).toContain("0 survivors, 0 untested, 1 incomplete");
});

test("the ownership pipe closes a worker's entire group when its command disappears", async () => {
  const started = Date.now();
  const cwd = `${root}/orphan`;
  const receipt = `${root}/orphan-receipt`;
  const source = "export function count(n: number) { return n + 1; }\n";
  await Bun.write(`${cwd}/count.ts`, source);
  await Bun.write(
    `${cwd}/package.json`,
    JSON.stringify({ scripts: { test: "bun test --isolate" } }),
  );
  await symlink(`${import.meta.dir}/../node_modules`, `${cwd}/node_modules`);
  await Bun.write(
    `${cwd}/count.test.ts`,
    `import { test } from "bun:test";
test("held", async () => {
  const descendant = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  await Bun.write(${JSON.stringify(receipt)}, JSON.stringify({ test: process.pid, descendant: descendant.pid }));
  await Bun.sleep(60000);
});`,
  );
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/mutation-worker.ts`], {
    cwd,
    detached: true,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const completion = result(child, 3000);
  await child.stdin.write(
    JSON.stringify({
      root: cwd,
      state: root,
      token: "orphan",
      identity: "admitted",
      selected: {
        units: [{ name: "count.ts", source, patterns: ["count.ts"], tests: ["./count.test.ts"] }],
        skipped: 0,
      },
    }) + "\n",
  );
  await child.stdin.flush();
  const deadline = Date.now() + 2000;
  while (!(await Bun.file(receipt).exists()) && Date.now() < deadline) await Bun.sleep(10);
  expect(await Bun.file(receipt).exists()).toBe(true);
  const owned = z
    .object({ test: z.number(), descendant: z.number() })
    .parse(await Bun.file(receipt).json());
  const closed = Date.now();
  await child.stdin.end();
  const [code, stdout, stderr] = await completion;
  expect(code).not.toBe(0);
  expect(stdout).toBe("");
  expect(stderr).toContain("run-completed");
  expect(Date.now() - closed).toBeLessThan(1000);
  for (const pid of [owned.test, owned.descendant]) {
    const status = Bun.spawnSync(["ps", "-p", String(pid), "-o", "stat="])
      .stdout.toString()
      .trim();
    expect(status === "" || status.startsWith("Z")).toBe(true);
  }
  expect(await Bun.file(`${root}/orphan/count.ts.json`).exists()).toBe(false);
  const interrupted = z
    .object({
      elapsedMs: z.number(),
      admission: z.object({ identity: z.string(), current: z.null(), reason: z.string() }),
      state: z.object({ status: z.string(), units: z.array(z.object({ status: z.string() })) }),
    })
    .parse(await Bun.file(`${cwd}/.mutation-runs/orphan.json`).json());
  expect(interrupted).toMatchObject({
    admission: { identity: "admitted", current: null, reason: "cancelled" },
    state: { status: "incomplete", units: [{ status: "interrupted" }] },
  });
  expect(interrupted.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(interrupted.elapsedMs).toBeLessThanOrEqual(Date.now() - started);
});
