import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
// Bun has no temporary-directory, symbolic-link, or recursive removal API.
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { MutationEvent } from "./mutation-run.ts";

setDefaultTimeout(20_000);
const root = await mkdtemp(`${tmpdir()}/mutation-worker-`);
afterAll(async () => rm(root, { recursive: true, force: true }));

type Worker = Bun.Subprocess<"pipe", "pipe", "pipe">;
type SpawnWorker = (options?: { cwd?: string; ipc?: (event: MutationEvent) => void }) => Worker;
let failedExchange: unknown;

function workerTest(
  name: string,
  exercise: (spawn: SpawnWorker) => Promise<void>,
  deadline = 2000,
) {
  test(name, async () => {
    expect(failedExchange, "an earlier owned worker exchange failed").toBeUndefined();
    const children: Worker[] = [];
    function spawn(options: Parameters<SpawnWorker>[0] = {}): Worker {
      const child = Bun.spawn([process.execPath, `${import.meta.dir}/mutation-worker.ts`], {
        ...options,
        detached: true,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      children.push(child);
      return child;
    }

    const expired = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => expired.resolve(false), deadline);
    const exercised = exercise(spawn);
    try {
      expect(
        await Promise.race([exercised.then(() => true), expired.promise]),
        `owned worker admission, IPC, effects and exit must complete within ${deadline}ms`,
      ).toBe(true);
    } catch (error) {
      failedExchange = error;
      // oxlint-disable-next-line unthrown/no-throw -- Preserve the original test assertion and fail later exchanges immediately.
      throw error;
    } finally {
      clearTimeout(timer);
      for (const child of children) {
        // Every worker starts a private detached group containing only this test's descendants.
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          expect(z.object({ code: z.literal("ESRCH") }).safeParse(error).success).toBe(true);
        }
        child.disconnect();
      }
      const reaped = Promise.withResolvers<boolean>();
      const cleanupTimer = setTimeout(() => reaped.resolve(false), 500);
      try {
        expect(
          await Promise.race([
            Promise.all([
              ...children.map(async (child) => {
                await child.stdin.end();
                await child.exited;
              }),
              exercised.catch(() => undefined),
            ]).then(() => true),
            reaped.promise,
          ]),
          "owned workers and blocked admission writes must settle after cleanup",
        ).toBe(true);
      } finally {
        clearTimeout(cleanupTimer);
      }
    }
  });
}

function result(child: Worker) {
  return Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
}

workerTest("worker refuses a closed admission pipe without executing a unit", async (spawn) => {
  const child = spawn();
  await child.stdin.end();
  const [code, stdout, stderr] = await result(child);
  expect(code).toBe(3);
  expect(stdout).toBe("");
  expect(stderr).toContain("admission incomplete");
});

workerTest(
  "worker reads complete large UTF-8 admission rather than treating a pipe chunk as a message",
  async (spawn) => {
    const child = spawn();
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
  },
);

workerTest(
  "native IPC publishes terminal evidence and waits for the owning command's receipt",
  async (spawn) => {
    const events: MutationEvent[] = [];
    const terminal = Promise.withResolvers<void>();
    const child = spawn({
      ipc(event: MutationEvent) {
        events.push(event);
        if (event.type === "run-completed") terminal.resolve();
      },
    });
    const completion = result(child);
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
  },
);

workerTest(
  "worker persists a real completed engine result and honestly reports an engine error",
  async (spawn) => {
    const cwd = `${root}/engine`;
    await Bun.write(
      `${cwd}/package.json`,
      JSON.stringify({ scripts: { test: "bun test --isolate" } }),
    );
    const source = "export function count(n: number) { return n + 1; }\n";
    await Bun.write(`${cwd}/count.ts`, source);
    await symlink(
      path.dirname(path.dirname(Bun.resolveSync("zod/package.json", import.meta.dir))),
      `${cwd}/node_modules`,
    );
    await Bun.write(
      `${cwd}/count.test.ts`,
      'import { expect, test } from "bun:test"; import { count } from "./count.ts"; test("exact", () => expect(count(1)).toBe(2));',
    );
    async function run(token: string, json = false, keepGoing = false) {
      const child = spawn({ cwd });
      const completion = result(child);
      await child.stdin.write(
        JSON.stringify({
          root: cwd,
          state: root,
          token,
          identity: "admitted",
          json,
          keepGoing,
          selected: {
            units: [
              { name: "count.ts", source, patterns: ["count.ts"], tests: ["./count.test.ts"] },
            ],
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
  },
  7000,
);

workerTest(
  "the ownership pipe closes a worker's entire group when its command disappears",
  async (spawn) => {
    const started = Date.now();
    const cwd = `${root}/orphan`;
    const receipt = `${root}/orphan-receipt`;
    const source = "export function count(n: number) { return n + 1; }\n";
    await Bun.write(`${cwd}/count.ts`, source);
    await Bun.write(
      `${cwd}/package.json`,
      JSON.stringify({ scripts: { test: "bun test --isolate" } }),
    );
    await symlink(
      path.dirname(path.dirname(Bun.resolveSync("zod/package.json", import.meta.dir))),
      `${cwd}/node_modules`,
    );
    await Bun.write(
      `${cwd}/count.test.ts`,
      `import { test } from "bun:test";
test("held", async () => {
  const descendant = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  await Bun.write(${JSON.stringify(receipt)}, JSON.stringify({ test: process.pid, descendant: descendant.pid }));
  await Bun.sleep(60000);
});`,
    );
    const child = spawn({ cwd });
    const completion = result(child);
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
  },
  3000,
);
