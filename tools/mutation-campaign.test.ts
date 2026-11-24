import { runMutationCampaign } from "./mutation-campaign.ts";
import { mutationInputIdentity } from "./mutation-snapshot.ts";
import { selectMutationUnits, type MutationUnit } from "./mutation-selection.ts";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
// Bun has no temporary-directory, symbolic-link, or recursive removal API.
import { cp, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireMutationClaim, mutationStateDirectory } from "./mutation-claim.ts";
import { z } from "zod";
import { mutationBudget } from "./mutation-budget.ts";
import { mutationEventSchema } from "./mutation-run.ts";

// Keep protocol assertions before real-engine effects in one file: parallel files do not bail together.
{
  const root = await mkdtemp(`${tmpdir()}/campaign-protocol-`);
  const installed = `${root}/installed/node_modules`;
  for (const name of ["zod", "@babel/parser"])
    await cp(
      path.dirname(Bun.resolveSync(`${name}/package.json`, import.meta.dir)),
      `${installed}/${name}`,
      { recursive: true, dereference: true },
    );
  describe("campaign protocol", () => {
    afterAll(() => rm(root, { recursive: true, force: true }));
    const source = "export const count = 1;\n";
    const unit = { name: "count.ts", source, tests: ["./count.test.ts"], patterns: ["count.ts"] };

    async function within<T>(work: Promise<T>, label: string, milliseconds = 10_000): Promise<T> {
      const expired = Promise.withResolvers<null>();
      const timer = setTimeout(() => expired.resolve(null), milliseconds);
      try {
        const result = await Promise.race([work.then((value) => ({ value })), expired.promise]);
        if (result === null) return expect.unreachable(label);
        return result.value;
      } finally {
        clearTimeout(timer);
      }
    }

    function stop(group: number) {
      try {
        process.kill(-group, "SIGKILL");
      } catch (error) {
        expect(z.object({ code: z.literal("ESRCH") }).safeParse(error).success).toBe(true);
      }
    }

    async function fixture(
      mode = "passed",
      selection: {
        units: readonly {
          name: string;
          source: string;
          tests: readonly string[];
          patterns: readonly string[];
        }[];
        skipped: number;
      } = { units: [unit], skipped: 2 },
    ) {
      const home = `${root}/${crypto.randomUUID()}`;
      const project = `${home}/project`;
      const receipt = `${home}/worker.json`;
      const acknowledgement = `${home}/ack.json`;
      const expiration = `${home}/expire`;
      const checkpoint = `${home}/budget-checkpoint.json`;
      const boot = `${home}/boot.json`;
      const caught = `${home}/caught.json`;
      const listeners = `${home}/listeners.json`;
      const armed = `${home}/armed`;
      const tooling = ["external-tools", "ownership-failure", "empty-install"].includes(mode)
        ? `${home}/tooling`
        : `${project}/tools`;
      await Bun.write(`${project}/count.ts`, source);
      await Bun.write(`${project}/count.test.ts`, "");
      if (mode !== "empty-install") await symlink(installed, `${project}/node_modules`);
      await symlink(installed, `${home}/node_modules`);
      if (mode === "admission" || mode === "ownership-failure")
        await Bun.write(`${project}/admission-input`, new Uint8Array(16_000_000));
      for (const name of [
        "mutation-campaign",
        "mutation-claim",
        "mutation-snapshot",
        "mutation-selection",
        "mutation-policy",
        "mutation-run",
        "mutation-evidence",
        "mutation-admission",
        "mutation-budget",
      ])
        await Bun.write(`${tooling}/${name}.ts`, Bun.file(`${import.meta.dir}/${name}.ts`));
      await Bun.write(
        `${tooling}/mutation-worker.ts`,
        `
const mode = ${JSON.stringify(mode)};
const {lstat} = await import("node:fs/promises");
await Bun.write(${JSON.stringify(boot)}, JSON.stringify({pid: process.pid}));
let payload = "";
const reader = Bun.stdin.stream().getReader();
while (!payload.includes("\\n")) {
  const next = await reader.read();
  if (next.done) process.exit(78);
  payload += new TextDecoder().decode(next.value);
}
const input = JSON.parse(payload);
const descendant = mode === "held" || mode === "budget"
  ? Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {stdout: "ignore", stderr: "ignore"}) : undefined;
const installedDirectory = (await lstat("node_modules").catch(() => null))?.isDirectory() ?? false;
await Bun.write(${JSON.stringify(receipt)}, JSON.stringify({pid: process.pid, descendant: descendant?.pid, cwd: process.cwd(), directoryMode: (await lstat(process.cwd())).mode & 0o777, entry: import.meta.path, installedDirectory, input}));
const selected = input.selected.units[0];
const result = {id: "owned", status: mode === "failed" ? "Survived" : "Killed", mutatorName: "ArithmeticOperator",
  location: {start: {line: 1, column: 1}, end: {line: 1, column: 2}}, replacement: "-"};
const evidence = {name: selected.name, tests: selected.tests, patterns: selected.patterns,
  status: mode === "failed" ? "failed" : "passed", mutants: [result], progress: {completed: 1, total: 1, reused: 0}};
const event = {version: 1, runId: input.token, sequence: 0, type: "unit-completed", elapsedMs: 1,
  state: {status: "running", activeUnit: null, completedUnits: 1, skipped: 2, units: [evidence]}};
process.on("message", async (value) => {
  await Bun.write(${JSON.stringify(acknowledgement)}, JSON.stringify(value));
  process.exit(mode === "failed" || mode === "exit-mismatch" ? 2 : 0);
});
if (mode === "held" || mode === "budget") {
  process.send({...event, type: "unit-started", state: {...event.state, completedUnits: 0, activeUnit: selected.name,
    units: [{...evidence, status: "running", mutants: null, progress: {completed: 0, total: null, reused: 0}}]}});
  await new Promise(() => {});
}
process.send(event);
if (mode === "early-exit") process.exit(0);
if (mode === "changed") await Bun.write(input.root + "/count.ts", "changed after admission");
const terminal = {...event, sequence: 1, type: "run-completed", state: {...event.state, status: mode === "failed" ? "failed" : "passed"}};
if (mode === "refusal-ipc") {
  process.send({version: 1, type: "refusal", reason: "budget-exhausted", code: 3});
} else if (mode === "malformed") {
  process.send({...terminal, state: {...terminal.state, units: [{...evidence, mutants: [{status: "Killed"}]}]}});
  process.send({...terminal, sequence: 2, state: {...terminal.state, units: [{...evidence, mutants: [{...result, id: "forbidden"}]}]}});
} else if (mode === "foreign") {
  process.send({...terminal, runId: "foreign"});
  process.send({...terminal, sequence: 2, state: {...terminal.state, units: [{...evidence, mutants: [{...result, id: "forbidden"}]}]}});
}
else process.send(terminal);
setTimeout(() => process.exit(79), 400);
`,
      );
      await Bun.write(
        `${project}/launch.ts`,
        `
import {runMutationCampaign} from ${JSON.stringify(`./${path.relative(project, tooling)}/mutation-campaign.ts`)};
import {mutationInputIdentity} from ${JSON.stringify(`./${path.relative(project, tooling)}/mutation-snapshot.ts`)};
import {mutationStateDirectory} from ${JSON.stringify(`./${path.relative(project, tooling)}/mutation-claim.ts`)};
import {mutationBudget} from ${JSON.stringify(`./${path.relative(project, tooling)}/mutation-budget.ts`)};
// Bun has no AbortSignal listener inspection API.
import {getEventListeners} from "node:events";
import path from "node:path";
const root = ${JSON.stringify(project)};
const state = await mutationStateDirectory(root);
await Bun.write(${JSON.stringify(`${home}/state`)}, state);
let clock = 0;
const budget = mutationBudget(60000, () => clock);
const write = Bun.write;
if (${JSON.stringify(mode)} === "copy-drift" || ${JSON.stringify(mode)} === "post-admission-tag") {
  Bun.write = async (file, data, ...options) => {
    const result = await write(file, data, ...options);
    if (typeof file === "string" && file.endsWith("/count.ts") && file !== root + "/count.ts") {
      await write(${JSON.stringify(checkpoint)}, JSON.stringify({
        directory: path.dirname(file), copied: await Bun.file(file).text()
      }));
      if (${JSON.stringify(mode)} === "copy-drift")
        await write(root + "/count.ts", "changed during copy");
    }
    if (${JSON.stringify(mode)} === "post-admission-tag" && typeof file === "string" &&
        file.startsWith(state + "/") && typeof data === "string" && JSON.parse(data).status === "running")
      throw new Error("failure after admission", {cause: "inputs-changed"});
    return result;
  };
}
if (${JSON.stringify(mode)} === "expire-before-worker") {
  Bun.write = async (file, data, ...options) => {
    const result = await write(file, data, ...options);
    if (typeof file === "string" && file.startsWith(state + "/") && typeof data === "string" &&
        JSON.parse(data).status === "running") {
      clock = 60000;
      await write(${JSON.stringify(checkpoint)}, JSON.stringify({aborted: budget.signal.aborted}));
    }
    return result;
  };
}
const handlers = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
if (${JSON.stringify(mode)} === "expired") clock = 60000;
const watcher = setInterval(async () => {
  if (process.listenerCount("SIGTERM") > handlers[1]) await Bun.write(${JSON.stringify(armed)}, "armed");
  if (await Bun.file(${JSON.stringify(expiration)}).exists()) {
    clock = 60000;
    try { budget.check(); } catch {}
  }
}, 5);
let code;
try {
  code = await runMutationCampaign(root, ${JSON.stringify(selection)},
    ${JSON.stringify(mode)} === "stale" ? "stale-identity" : await mutationInputIdentity(root),
    {json: ${mode !== "human"}, keepGoing: true, preflight: false, budget});
} catch (error) {
  const processes = Bun.spawnSync(["ps", "-o", "pid=,stat=,args=", "--ppid", String(process.pid)]).stdout.toString();
  const owned = processes.split("\\n").filter((line) => line.includes(${JSON.stringify(`${tooling}/mutation-worker.ts`)}))
    .map((line) => line.trim().split(/\\s+/));
  await Bun.write(${JSON.stringify(caught)}, JSON.stringify({
    message: String(error), alive: owned.some((row) => !row[1].startsWith("Z")),
    pids: owned.map((row) => Number(row[0])), cause: error instanceof Error ? error.cause : undefined
  }));
  code = 7;
} finally {
  Bun.write = write;
  clearInterval(watcher);
  budget.dispose();
}
await Bun.write(${JSON.stringify(listeners)}, JSON.stringify({
  before: handlers, after: [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")],
  abortListenersReleased: getEventListeners(budget.signal, "abort").length === 0
}));
console.error("RESULT " + code);
process.exit(code);
`,
      );
      let stopped = false;
      async function claimed() {
        while (!stopped && !(await Bun.file(armed).exists())) await Bun.sleep(1);
        if (stopped)
          return expect.unreachable("campaign stopped before its claim state was available");
        const state = await Bun.file(`${home}/state`).text();
        const file = `${state}/claim/owner.json`;
        while (!stopped && !(await Bun.file(file).exists())) await Bun.sleep(1);
        if (stopped) return expect.unreachable("campaign stopped before acquiring its claim");
        return file;
      }

      async function entered() {
        while (!stopped && !(await Bun.file(receipt).exists())) await Bun.sleep(2);
        if (stopped) return expect.unreachable("campaign stopped before worker admission");
        const worker = z
          .object({
            pid: z.number(),
            descendant: z.number().optional(),
            cwd: z.string(),
            input: z.object({ token: z.string() }),
          })
          .parse(await Bun.file(receipt).json());
        const active = z.object({ state: z.object({ activeUnit: z.string().nullable() }) });
        while (
          !stopped &&
          active.safeParse(
            await Bun.file(`${project}/.mutation-runs/${worker.input.token}.json`)
              .json()
              .catch(() => null),
          ).data?.state.activeUnit !== "count.ts"
        )
          await Bun.sleep(2);
        if (stopped)
          return expect.unreachable("campaign stopped before persisting its worker event");
        return worker;
      }

      async function run(
        action?: (child: Bun.Subprocess<"ignore", "pipe", "pipe">) => Promise<void>,
      ) {
        const started = Date.now();
        const child = Bun.spawn([process.execPath, `${project}/launch.ts`], {
          cwd: project,
          detached: true,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        try {
          const finished = Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          const [code, stdout, stderr] = await within(
            (async () => {
              await action?.(child);
              return finished;
            })(),
            "campaign must finish its private worker protocol before the deadline",
          );
          const state = await Bun.file(`${home}/state`).text();
          const names = await Array.fromAsync(new Bun.Glob("*.json").scan(state));
          const reports = await Promise.all(
            names.map((name) => Bun.file(`${state}/${name}`).json()),
          );
          const frames =
            mode !== "human" && stdout.trim()
              ? stdout
                  .trim()
                  .split("\n")
                  .map((line) =>
                    z.object({ type: z.string() }).passthrough().parse(JSON.parse(line)),
                  )
              : [];
          const refusals = frames.filter((frame) => frame.type === "refusal");
          const events = frames
            .filter((frame) => frame.type !== "refusal")
            .map((frame) => mutationEventSchema.parse(frame));
          // Observe production termination before fallback cleanup can stop surviving fixture children.
          const observed = z
            .object({ pid: z.number(), descendant: z.number().optional() })
            .safeParse(
              await Bun.file(receipt)
                .json()
                .catch(() => null),
            );
          const productionProcesses: { pid: number; alive: boolean }[] = [];
          if (observed.success) {
            const pids = [observed.data.pid];
            if (observed.data.descendant !== undefined) pids.push(observed.data.descendant);
            for (const pid of pids) {
              const status = Bun.spawnSync(["ps", "-p", String(pid), "-o", "stat="])
                .stdout.toString()
                .trim();
              productionProcesses.push({ pid, alive: status !== "" && !status.startsWith("Z") });
            }
          }
          return {
            code,
            stdout,
            stderr,
            state,
            reports,
            events,
            refusals,
            productionProcesses,
            elapsed: Date.now() - started,
          };
        } finally {
          stopped = true;
          const worker = z.object({ pid: z.number() }).safeParse(
            await Bun.file(boot)
              .json()
              .catch(() => null),
          );
          if (worker.success) stop(worker.data.pid);
          const pending = z.object({ pids: z.array(z.number()) }).safeParse(
            await Bun.file(caught)
              .json()
              .catch(() => null),
          );
          if (pending.success) for (const pid of pending.data.pids) stop(pid);
          stop(child.pid);
          await within(child.exited, "owned campaign process must be reaped after cleanup");
        }
      }

      return {
        project,
        tooling,
        receipt,
        acknowledgement,
        expiration,
        checkpoint,
        boot,
        mode,
        caught,
        listeners,
        claimed,
        entered,
        run,
      };
    }

    test("copy-time input drift refuses once before worker execution and releases admitted resources", async () => {
      const example = await fixture("copy-drift");
      const result = await example.run();
      const copied = z
        .object({ directory: z.string(), copied: z.string() })
        .parse(await Bun.file(example.checkpoint).json());
      expect(copied.copied).toBe(source);
      expect(await Bun.file(`${example.project}/count.ts`).text()).toBe("changed during copy");
      expect(result.code, result.stderr).toBe(3);
      expect(result.refusals).toEqual([
        { version: 1, type: "refusal", reason: "inputs-changed", code: 3 },
      ]);
      expect(result.events).toEqual([]);
      expect(result.reports).toEqual([]);
      expect(await Bun.file(example.boot).exists()).toBe(false);
      expect(await Bun.file(example.receipt).exists()).toBe(false);
      expect(await Bun.file(`${result.state}/claim/owner.json`).exists()).toBe(false);
      expect(
        await Array.fromAsync(
          new Bun.Glob(".mutation-runs/*").scan({ cwd: example.project, dot: true }),
        ),
      ).toEqual([]);
      await expect(lstat(copied.directory)).rejects.toHaveProperty("code", "ENOENT");
    });

    test("a tagged failure after admission does not fabricate a refusal or start a worker", async () => {
      const example = await fixture("post-admission-tag");
      const result = await example.run();
      const copied = z
        .object({ directory: z.string(), copied: z.string() })
        .parse(await Bun.file(example.checkpoint).json());
      expect(copied.copied).toBe(source);
      expect(await Bun.file(`${example.project}/count.ts`).text()).toBe(source);
      expect(result.refusals).toEqual([]);
      expect(result.events).toEqual([]);
      expect(result.code, result.stderr).toBe(7);
      expect(result.reports).toMatchObject([{ version: 1, status: "running" }]);
      expect(await Bun.file(example.caught).json()).toMatchObject({
        cause: "inputs-changed",
        alive: false,
        pids: [],
      });
      expect(await Bun.file(example.boot).exists()).toBe(false);
      expect(await Bun.file(example.receipt).exists()).toBe(false);
      expect(await Bun.file(`${result.state}/claim/owner.json`).exists()).toBe(false);
      await expect(lstat(copied.directory)).rejects.toHaveProperty("code", "ENOENT");
    });

    test("campaign admits the selected snapshot, acknowledges terminal IPC, and releases owned resources", async () => {
      const example = await fixture();
      const result = await example.run();
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("Mutation execution incomplete:");
      const observed = z
        .object({
          cwd: z.string(),
          directoryMode: z.number(),
          entry: z.string(),
          input: z.object({
            root: z.string(),
            identity: z.string(),
            token: z.string(),
            selected: z.unknown(),
            json: z.boolean(),
            keepGoing: z.boolean(),
            preflight: z.boolean(),
          }),
        })
        .parse(await Bun.file(example.receipt).json());
      expect(observed.input).toMatchObject({
        root: example.project,
        selected: { units: [unit], skipped: 2 },
        json: true,
        keepGoing: true,
        preflight: false,
      });
      expect(observed.entry).toBe(`${observed.cwd}/tools/mutation-worker.ts`);
      expect(observed.cwd).not.toBe(example.project);
      expect(observed.directoryMode).toBe(0o700);
      expect(await Bun.file(example.acknowledgement).json()).toEqual({});
      expect(result.reports).toEqual([
        {
          version: 1,
          identity: observed.input.identity,
          current: true,
          status: "qualified",
          code: 0,
        },
      ]);
      expect(result.events.map((event) => event.type)).toEqual(["unit-completed", "run-completed"]);
      expect(result.refusals).toEqual([]);
      expect(result.events[0]?.admission).toEqual({
        identity: observed.input.identity,
        current: null,
      });
      expect(result.events.at(-1)).toMatchObject({
        runId: observed.input.token,
        admission: { identity: observed.input.identity, current: true },
        state: { status: "passed", completedUnits: 1, skipped: 2, units: [{ status: "passed" }] },
      });
      expect(await Bun.file(`${result.state}/claim/owner.json`).exists()).toBe(false);
      expect(await Bun.file(example.listeners).json()).toMatchObject({
        before: [0, 0],
        after: [0, 0],
        abortListenersReleased: true,
      });
      expect(result.events.at(-1)?.elapsedMs).toBeLessThanOrEqual(result.elapsed);
      await expect(lstat(observed.cwd)).rejects.toHaveProperty("code", "ENOENT");
    });

    test.each(["failed", "exit-mismatch", "early-exit"] as const)(
      "a %s worker outcome cannot qualify the campaign",
      async (mode) => {
        const example = await fixture(mode);
        const result = await example.run();
        expect(result.code, result.stderr).toBe(
          mode === "failed" || mode === "exit-mismatch" ? 2 : 3,
        );
        expect(result.reports).toMatchObject([
          { current: true, status: "failed", code: result.code },
        ]);
        expect(result.events.at(-1)).toMatchObject({
          type: "run-completed",
          state: {
            status: mode === "failed" ? "failed" : mode === "early-exit" ? "incomplete" : "passed",
          },
        });
        expect(await Bun.file(`${result.state}/claim/owner.json`).exists()).toBe(false);
      },
    );

    test.each(["foreign", "malformed", "refusal-ipc"] as const)(
      "%s IPC preserves the last valid verdict, refuses acknowledgement, and cancels owned work",
      async (mode) => {
        const example = await fixture(mode);
        const result = await example.run();
        expect(result.code, result.stderr).toBe(3);
        expect(result.stderr).toContain(
          "Mutation execution incomplete: cancelled. Historical evidence:",
        );
        expect(result.stderr).toContain("Invalid mutation worker event. Execution cannot qualify.");
        expect(result.reports).toMatchObject([{ current: true, status: "cancelled", code: 3 }]);
        expect(result.events.at(-1)).toMatchObject({
          admission: { current: true, reason: "cancelled" },
          state: {
            status: "incomplete",
            completedUnits: 1,
            units: [{ mutants: [{ id: "owned", status: "Killed" }] }],
          },
        });
        expect(await Bun.file(example.acknowledgement).exists()).toBe(false);
      },
    );

    test("current input drift preserves admitted verdicts but makes qualification incomplete", async () => {
      const example = await fixture("changed");
      const result = await example.run();
      expect(result.code, result.stderr).toBe(3);
      expect(result.stderr).toContain(
        "Mutation execution incomplete: inputs-changed. Historical evidence:",
      );
      expect(result.reports).toMatchObject([{ current: false, status: "inputs-changed", code: 3 }]);
      expect(result.events.at(-1)).toMatchObject({
        admission: { current: false, reason: "inputs-changed" },
        state: {
          status: "incomplete",
          completedUnits: 1,
          units: [{ status: "passed", mutants: [{ status: "Killed" }] }],
        },
      });
      expect(await Bun.file(`${example.project}/count.ts`).text()).toBe("changed after admission");
    });

    test.each([
      { mode: "stale", selection: { units: [unit], skipped: 2 } },
      { mode: "passed", selection: { units: [{ ...unit, source: "stale source" }], skipped: 2 } },
      { mode: "passed", selection: { units: [{ ...unit, tests: [] }], skipped: 2 } },
      { mode: "passed", selection: { units: [{ ...unit, name: "missing.ts" }], skipped: 2 } },
    ])(
      "admission refuses a changed identity or selected input before any worker effect: %j",
      async ({ mode, selection }) => {
        const example = await fixture(mode, selection);
        const result = await example.run();
        expect(result.code, result.stderr).toBe(3);
        expect(result.stderr).toContain("Mutation inputs changed during selection.");
        expect(result.reports).toEqual([]);
        expect(result.events).toEqual([]);
        expect(result.refusals).toEqual([
          { version: 1, type: "refusal", reason: "inputs-changed", code: 3 },
        ]);
        expect(await Bun.file(example.receipt).exists()).toBe(false);
        expect(await Bun.file(`${result.state}/claim/owner.json`).exists()).toBe(false);
        expect(await Bun.file(`${example.project}/count.ts`).text()).toBe(source);
      },
    );

    test("an already-expired budget persists unrun work and never starts a worker", async () => {
      const example = await fixture("expired");
      const result = await example.run();
      expect(result.code, result.stderr).toBe(3);
      expect(result.stderr).toContain(
        "Mutation execution incomplete: budget-exhausted. Historical evidence:",
      );
      expect(result.events.at(-1)?.elapsedMs).toBeLessThanOrEqual(result.elapsed);
      expect(result.reports).toMatchObject([
        { current: null, status: "budget-exhausted", code: 3 },
      ]);
      expect(result.events.at(-1)).toMatchObject({
        type: "run-completed",
        admission: { current: null, reason: "budget-exhausted" },
        state: {
          status: "incomplete",
          activeUnit: null,
          completedUnits: 0,
          skipped: 2,
          units: [{ name: "count.ts", status: "unrun", mutants: null }],
        },
      });
      expect(await Bun.file(example.receipt).exists()).toBe(false);
      expect(await Bun.file(`${result.state}/claim/owner.json`).exists()).toBe(false);
    });

    test("an expired budget wins before invalid selected inputs can refuse admission", async () => {
      const example = await fixture("expired", {
        units: [{ ...unit, tests: [] }],
        skipped: 2,
      });
      const result = await example.run();
      expect(result.code, result.stderr).toBe(3);
      expect(result.reports).toMatchObject([
        { current: null, status: "budget-exhausted", code: 3 },
      ]);
      expect(result.events.at(-1)).toMatchObject({
        admission: { current: null, reason: "budget-exhausted" },
        state: { status: "incomplete", units: [{ status: "unrun", mutants: null }] },
      });
      expect(result.refusals).toEqual([]);
      expect(await Bun.file(example.boot).exists()).toBe(false);
      expect(await Bun.file(`${result.state}/claim/owner.json`).exists()).toBe(false);
    });

    test("expiry after the running report prevents worker launch before the timer fires", async () => {
      const example = await fixture("expire-before-worker");
      const result = await example.run();
      expect(await Bun.file(example.checkpoint).json()).toEqual({ aborted: false });
      expect(await Bun.file(example.boot).exists()).toBe(false);
      expect(await Bun.file(example.receipt).exists()).toBe(false);
      expect(result.code, result.stderr).toBe(3);
      expect(result.reports).toMatchObject([
        { current: null, status: "budget-exhausted", code: 3 },
      ]);
      expect(result.events.at(-1)).toMatchObject({
        admission: { current: null, reason: "budget-exhausted" },
        state: { status: "incomplete", units: [{ status: "unrun", mutants: null }] },
      });
      expect(result.refusals).toEqual([]);
      expect(await Bun.file(`${result.state}/claim/owner.json`).exists()).toBe(false);
    });

    test.each(["SIGINT", "SIGTERM", "budget"] as const)(
      "%s stops only owned worker descendants, persists interruption, and releases the claim",
      async (signal) => {
        const example = await fixture(signal === "budget" ? "budget" : "held");
        const unrelated = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
          stdout: "ignore",
          stderr: "ignore",
        });
        try {
          const result = await example.run(async (child) => {
            await example.entered();
            if (signal === "budget") await Bun.write(example.expiration, "expire");
            else child.kill(signal);
          });
          expect(result.code, result.stderr).toBe(3);
          expect(result.reports).toMatchObject([
            {
              current: signal === "budget" ? null : true,
              status: signal === "budget" ? "budget-exhausted" : "cancelled",
              code: 3,
            },
          ]);
          expect(result.events.at(-1)).toMatchObject({
            admission: {
              current: signal === "budget" ? null : true,
              reason: signal === "budget" ? "budget-exhausted" : "cancelled",
            },
            state: {
              status: "incomplete",
              activeUnit: null,
              units: [{ status: "interrupted", mutants: null }],
            },
          });
          const owned = z
            .object({ pid: z.number(), descendant: z.number(), cwd: z.string() })
            .parse(await Bun.file(example.receipt).json());
          expect(result.productionProcesses).toEqual([
            { pid: owned.pid, alive: false },
            { pid: owned.descendant, alive: false },
          ]);
          expect(unrelated.exitCode).toBeNull();
          expect(process.kill(unrelated.pid, 0)).toBe(true);
          expect(await Bun.file(`${result.state}/claim/owner.json`).exists()).toBe(false);
          await expect(lstat(owned.cwd)).rejects.toHaveProperty("code", "ENOENT");
        } finally {
          unrelated.kill("SIGKILL");
          await unrelated.exited;
        }
      },
    );

    test("human reporting persists final evidence without writing machine events to stdout", async () => {
      const example = await fixture("human");
      const result = await example.run();
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("run-completed, passed");
      const files = await Array.fromAsync(
        new Bun.Glob(".mutation-runs/*.json").scan({ cwd: example.project, dot: true }),
      );
      expect(files).toHaveLength(1);
      expect(
        mutationEventSchema.parse(await Bun.file(`${example.project}/${files[0]}`).json()),
      ).toMatchObject({
        type: "run-completed",
        admission: { current: true },
        state: { status: "passed" },
      });
    });

    test("a busy claim refuses admission without overwriting its owner or starting a worker", async () => {
      const example = await fixture();
      const state = await mutationStateDirectory(example.project);
      const claim = await acquireMutationClaim(state);
      if ("error" in claim) return expect.unreachable(claim.error);
      try {
        const owner = await Bun.file(`${state}/claim/owner.json`).text();
        const result = await example.run();
        expect(result.code, result.stderr).toBe(3);
        expect(result.stderr).toContain("Mutation worktree busy.");
        expect(result.reports).toEqual([]);
        expect(result.events).toEqual([]);
        expect(result.refusals).toEqual([
          { version: 1, type: "refusal", reason: "worktree-busy", code: 3 },
        ]);
        expect(await Bun.file(example.receipt).exists()).toBe(false);
        expect(await Bun.file(`${state}/claim/owner.json`).text()).toBe(owner);
      } finally {
        await claim.release();
      }
    });

    test("external tooling keeps its worker entry while executing in the admitted project", async () => {
      const example = await fixture("external-tools");
      const result = await example.run();
      expect(result.code, result.stderr).toBe(0);
      const observed = z
        .object({ cwd: z.string(), entry: z.string() })
        .parse(await Bun.file(example.receipt).json());
      expect(observed.entry).toBe(`${example.tooling}/mutation-worker.ts`);
      expect(observed.cwd).not.toBe(example.project);
      expect(await Bun.file(`${observed.cwd}/count.ts`).exists()).toBe(false);
      await expect(lstat(observed.cwd)).rejects.toHaveProperty("code", "ENOENT");
    });

    test("a live campaign records its admitted identity as running before it can qualify", async () => {
      const example = await fixture("held");
      let running: unknown;
      const result = await example.run(async (child) => {
        const observed = await example.entered();
        const state = await Bun.file(`${path.dirname(example.project)}/state`).text();
        running = await Bun.file(`${state}/${observed.input.token}.json`).json();
        child.kill("SIGTERM");
      });
      expect(result.code, result.stderr).toBe(3);
      expect(running).toEqual({
        version: 1,
        identity: result.events[0]?.admission?.identity,
        status: "running",
      });
    });

    test("cancellation during admission never launches a worker and retains selected work as unrun", async () => {
      const example = await fixture("admission");
      const result = await example.run(async (child) => {
        await example.claimed();
        child.kill("SIGTERM");
      });
      expect(result.code, result.stderr).toBe(3);
      expect(result.stderr).not.toContain("TypeError");
      expect(await Bun.file(example.receipt).exists()).toBe(false);
      expect(result.events.at(-1)).toMatchObject({
        type: "run-completed",
        admission: { current: true, reason: "cancelled" },
        state: {
          status: "incomplete",
          completedUnits: 0,
          units: [{ status: "unrun", mutants: null }],
        },
      });
      expect(result.reports).toMatchObject([{ status: "cancelled", current: true, code: 3 }]);
    });

    test("ownership-record failure stops the launched worker before propagating the error", async () => {
      const example = await fixture("ownership-failure");
      const result = await example.run(async () => {
        const owner = await example.claimed();
        await rm(owner);
        await mkdir(owner);
      });
      expect(result.code, result.stderr).toBe(7);
      expect(await Bun.file(example.caught).json()).toMatchObject({ alive: false });
      expect(
        z.object({ message: z.string() }).parse(await Bun.file(example.caught).json()).message,
      ).toContain("EISDIR");
      expect((await lstat(`${result.state}/claim/owner.json`)).isDirectory()).toBe(true);
    });

    test("an application without installed inputs receives a private empty installation root", async () => {
      const example = await fixture("empty-install");
      const result = await example.run();
      expect(result.code, result.stderr).toBe(0);
      expect(await Bun.file(example.receipt).json()).toMatchObject({ installedDirectory: true });
      await expect(lstat(`${example.project}/node_modules`)).rejects.toHaveProperty(
        "code",
        "ENOENT",
      );
    });
  });
}

setDefaultTimeout(60_000);
const root = await mkdtemp(`${tmpdir()}/mutation-ownership-`);
const script = `${import.meta.dir}/mutate.ts`;
const installed = path.dirname(path.dirname(Bun.resolveSync("zod/package.json", import.meta.dir)));
afterAll(async () => rm(root, { recursive: true, force: true }));

async function fixture(packages: "application" | "toolchain" | "protocol" = "application") {
  const cwd = `${root}/${crypto.randomUUID()}`;
  await Bun.write(
    `${cwd}/package.json`,
    JSON.stringify({ type: "module", scripts: { test: "bun test --isolate" } }),
  );
  await Bun.write(`${cwd}/count.ts`, "export function count(n: number) { return n + 1; }\n");
  if (packages === "toolchain") await symlink(installed, `${cwd}/node_modules`);
  else {
    await mkdir(`${cwd}/node_modules`);
    if (packages === "protocol")
      for (const dependency of ["zod", "@babel/parser"])
        await cp(`${installed}/${dependency}`, `${cwd}/node_modules/${dependency}`, {
          recursive: true,
          verbatimSymlinks: true,
        });
  }
  return cwd;
}

function signalFixtureGroup(group: number) {
  try {
    process.kill(-group, "SIGKILL");
  } catch (error) {
    expect(z.object({ code: z.literal("ESRCH") }).safeParse(error).success).toBe(true);
  }
}

function start(cwd: string, args = ["count.ts"], entry = script, preload?: string) {
  const state = mutationStateDirectory(cwd);
  const child = Bun.spawn(
    [process.execPath, ...(preload ? ["--preload", preload] : []), entry, ...args],
    {
      cwd,
      detached: true,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  async function stop() {
    const claim = z.object({ group: z.number().positive() }).safeParse(
      await Bun.file(`${await state}/claim/owner.json`)
        .json()
        .catch(() => undefined),
    );
    if (claim.success) signalFixtureGroup(claim.data.group);
    signalFixtureGroup(child.pid);
  }

  const deadline = setTimeout(() => {
    void stop();
  }, 60_000);
  const result = Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(deadline));
  return { child, result, stop };
}

async function waitFor(file: string) {
  const deadline = Date.now() + 45_000;
  while (!(await Bun.file(file).exists()) && Date.now() < deadline) await Bun.sleep(20);
  expect(await Bun.file(file).exists()).toBe(true);
}

async function finishedBeforeCleanup(run: ReturnType<typeof start>, milliseconds: number) {
  const stopped = Promise.withResolvers<never>();
  const deadline = setTimeout(
    () => stopped.reject(new Error("Owned work did not stop before fixture cleanup.")),
    milliseconds,
  );
  try {
    return await Promise.race([run.result, stopped.promise]);
  } finally {
    clearTimeout(deadline);
  }
}

async function admissionReport(state: string) {
  const reports = await Array.fromAsync(new Bun.Glob("*.json").scan(state));
  expect(reports).toHaveLength(1);
  return z
    .object({
      version: z.literal(1),
      identity: z.string(),
      status: z.string(),
      current: z.boolean().nullable().optional(),
    })
    .parse(await Bun.file(`${state}/${reports[0]}`).json());
}

async function runEvidence(cwd: string) {
  const files = await Array.fromAsync(
    new Bun.Glob(".mutation-runs/*.json").scan({ cwd, dot: true }),
  );
  expect(files).toHaveLength(1);
  return z
    .object({
      elapsedMs: z.number(),
      admission: z.object({
        identity: z.string(),
        current: z.boolean().nullable(),
        reason: z.string().optional(),
      }),
      state: z.object({
        status: z.string(),
        units: z.array(
          z.object({
            status: z.string(),
            mutants: z.array(z.looseObject({ status: z.string() })).nullable(),
          }),
        ),
      }),
    })
    .parse(await Bun.file(`${cwd}/${files[0]}`).json());
}

test("budget expiry stops owned work, retains completed verdicts and leaves later work unrun", async () => {
  const cwd = await fixture();
  const entered = `${root}/budget-entered`;
  const forbidden = `${root}/budget-forbidden`;
  await Bun.write(
    `${cwd}/count.test.ts`,
    `import {expect, test} from "bun:test";
import {count} from "./count.ts"; test("count", async () => { await Bun.sleep(1000); expect(count(1)).toBe(2); });`,
  );
  await Bun.write(`${cwd}/held.ts`, "export const held = 1;\n");
  await Bun.write(
    `${cwd}/held.test.ts`,
    `import {test, expect} from "bun:test";
import {held} from "./held.ts";
test("held", async () => {
  await Bun.write(${JSON.stringify(entered)}, "entered");
  await Bun.sleep(30_000);
  await Bun.write(${JSON.stringify(forbidden)}, "forbidden");
  expect(held).toBe(1);
});`,
  );
  await Bun.write(`${cwd}/later.ts`, "export const later = 1;\n");
  await Bun.write(
    `${cwd}/later.test.ts`,
    `await Bun.write(${JSON.stringify(forbidden)}, "later");`,
  );
  const selected = await selectMutationUnits({ paths: ["count.ts", "held.ts", "later.ts"] }, cwd);
  if ("error" in selected) return expect.unreachable(selected.error);
  let clock = 0;
  const budget = mutationBudget(60_000, () => clock);
  const run = runMutationCampaign(cwd, selected, await mutationInputIdentity(cwd), { budget });
  try {
    // Admission and the completed unit may take arbitrarily longer than a CLI diagnostic budget.
    // Expire only after the real held test starts, not after an assumed engine startup time.
    const deadline = Date.now() + 45_000;
    while (!(await Bun.file(entered).exists()) && Date.now() < deadline) await Bun.sleep(20);
    expect(await Bun.file(entered).exists()).toBe(true);
    clock = 60_000;
    expect(() => budget.check()).toThrow("budget-exhausted");
    const stopped = Promise.withResolvers<never>();
    const timeout = setTimeout(
      () => stopped.reject(new Error("Owned budget did not stop work.")),
      2000,
    );
    try {
      expect(await Promise.race([run, stopped.promise])).toBe(3);
    } finally {
      clearTimeout(timeout);
    }
    expect(await Bun.file(forbidden).exists()).toBe(false);
    const evidence = await runEvidence(cwd);
    expect(evidence.admission.reason).toBe("budget-exhausted");
    expect(evidence.state.status).toBe("incomplete");
    expect(evidence.state.units.map((unit) => unit.status)).toEqual([
      "passed",
      "interrupted",
      "unrun",
    ]);
    expect(evidence.state.units[0]?.mutants?.map((mutant) => mutant.status)).toEqual([
      "Killed",
      "Killed",
    ]);
    expect(evidence.state.units[1]?.mutants).toBeNull();
    expect(evidence.state.units[2]?.mutants).toBeNull();
    expect((await admissionReport(await mutationStateDirectory(cwd))).status).toBe(
      "budget-exhausted",
    );
    await Bun.sleep(30);
    expect(await runEvidence(cwd)).toEqual(evidence);
    expect(await Bun.file(forbidden).exists()).toBe(false);
  } finally {
    clock = 60_000;
    try {
      budget.check();
    } catch {
      // Expiry also cleans up a worker when an assertion fails before the planned interruption.
    }
    await run;
    budget.dispose();
  }
});

test("an exhausted admission budget records all work unrun without launching tests", async () => {
  const cwd = await fixture();
  const receipt = `${root}/admission-budget-forbidden`;
  await Bun.write(
    `${cwd}/count.test.ts`,
    `await Bun.write(${JSON.stringify(receipt)}, "forbidden");`,
  );
  const identity = await mutationInputIdentity(cwd);
  let clock = 0;
  const budget = mutationBudget(1000, () => clock);
  clock = 1000;
  try {
    const code = await runMutationCampaign(
      cwd,
      {
        units: [
          {
            name: "count.ts",
            source: await Bun.file(`${cwd}/count.ts`).text(),
            patterns: ["count.ts"],
            tests: ["./count.test.ts"],
          },
        ],
        skipped: 0,
      },
      identity,
      { budget },
    );
    expect(code).toBe(3);
    expect(await Bun.file(receipt).exists()).toBe(false);
    const evidence = await runEvidence(cwd);
    expect(evidence.admission).toEqual({ identity, current: null, reason: "budget-exhausted" });
    expect(evidence.state.status).toBe("incomplete");
    expect(evidence.state.units.map((unit) => unit.status)).toEqual(["unrun"]);
    expect(evidence.state.units[0]?.mutants).toBeNull();
    expect((await admissionReport(await mutationStateDirectory(cwd))).status).toBe(
      "budget-exhausted",
    );
  } finally {
    budget.dispose();
  }
});

test("expiry before the first worker event persists selected work as unrun", async () => {
  const cwd = await fixture("protocol");
  const entered = `${root}/silent-worker-entered`;
  const forbidden = `${root}/silent-worker-forbidden`;
  for (const name of [
    "mutate",
    "mutation-campaign",
    "mutation-claim",
    "mutation-snapshot",
    "mutation-run",
    "mutation-selection",
    "mutation-policy",
    "mutation-admission",
    "mutation-evidence",
    "mutation-engine-progress",
    "mutation-plan",
    "mutation-budget",
  ])
    await Bun.write(`${cwd}/tools/${name}.ts`, Bun.file(`${import.meta.dir}/${name}.ts`));
  await Bun.write(
    `${cwd}/tools/mutation-resume.ts`,
    Bun.file(`${import.meta.dir}/mutation-resume.ts`),
  );
  await Bun.write(
    `${cwd}/tools/mutation-worker.ts`,
    `await Bun.write(${JSON.stringify(entered)}, "entered");
await Bun.sleep(30_000);
await Bun.write(${JSON.stringify(forbidden)}, "forbidden");`,
  );
  await Bun.write(
    `${cwd}/count.test.ts`,
    `await Bun.write(${JSON.stringify(forbidden)}, "tests");`,
  );
  const run = start(cwd, ["--json", "--budget", "5", "count.ts"], `${cwd}/tools/mutate.ts`);
  try {
    const [code, stdout, stderr] = await finishedBeforeCleanup(run, 7500);
    expect(code, stdout + stderr).toBe(3);
    expect(await Bun.file(entered).exists()).toBe(true);
    expect(await Bun.file(forbidden).exists()).toBe(false);
    const evidence = await runEvidence(cwd);
    expect(evidence.admission.reason).toBe("budget-exhausted");
    expect(evidence.state.status).toBe("incomplete");
    expect(evidence.state.units.map((unit) => unit.status)).toEqual(["unrun"]);
    expect(evidence.state.units[0]?.mutants).toBeNull();
  } finally {
    await run.stop();
  }
});

test("a competing command refuses before tests or shared evidence changes", async () => {
  const started = Date.now();
  const cwd = await fixture();
  const entered = `${root}/entered`;
  const release = `${root}/release`;
  await Bun.write(
    `${cwd}/count.test.ts`,
    `import { expect, test } from "bun:test";
import { count } from "./count.ts";
test("held", async () => {
  await Bun.write(${JSON.stringify(entered)}, "entered");
  while (!(await Bun.file(${JSON.stringify(release)}).exists())) await Bun.sleep(20);
  expect(count(1)).toBe(2);
}, 60_000);`,
  );
  const first = start(cwd);
  try {
    await waitFor(entered);
    const state = await mutationStateDirectory(cwd);
    const before = await Bun.file(`${state}/claim/owner.json`).text();
    expect(z.object({ group: z.number().positive() }).safeParse(JSON.parse(before)).success).toBe(
      true,
    );
    expect((await admissionReport(state)).status).toBe("running");
    expect((await runEvidence(cwd)).admission).toEqual({
      identity: (await admissionReport(state)).identity,
      current: null,
    });
    const [code, , stderr] = await start(cwd).result;
    expect(code).toBe(3);
    expect(stderr).toContain("worktree busy");
    expect(await Bun.file(`${state}/claim/owner.json`).text()).toBe(before);
    await Bun.write(release, "go");
    const [firstCode, stdout, firstError] = await first.result;
    expect(firstCode, stdout + firstError).toBe(0);
    expect((await admissionReport(state)).status).toBe("qualified");
    expect((await runEvidence(cwd)).admission.current).toBe(true);
    expect((await runEvidence(cwd)).elapsedMs).toBeLessThanOrEqual(Date.now() - started);
    expect(
      (
        await Array.fromAsync(new Bun.Glob(".mutation-*").scan({ cwd, onlyFiles: false }))
      ).toSorted(),
    ).toEqual([".mutation-incremental", ".mutation-runs"]);
  } finally {
    await first.stop();
  }
});

test.each(["source", "installed", "alias"])(
  "all units retain admitted inputs after %s edits",
  async (changed) => {
    const cwd = await fixture();
    await rm(`${cwd}/node_modules`, { recursive: true });
    await cp(installed, `${cwd}/node_modules`, {
      recursive: true,
      verbatimSymlinks: true,
    });
    await Bun.write(
      `${cwd}/package.json`,
      JSON.stringify({
        type: "module",
        scripts: { test: "bun test --isolate" },
        dependencies: { application: "1" },
      }),
    );
    await Bun.write(`${cwd}/node_modules/application/package.json`, '{"main":"index.js"}');
    await Bun.write(
      `${cwd}/node_modules/application/index.js`,
      'export const installed = "admitted";',
    );
    if (changed === "alias") {
      await rm(`${cwd}/node_modules/application`, { recursive: true });
      for (const store of ["first", "second"]) {
        const installed = `${cwd}/node_modules/.bun/${store}/node_modules`;
        await Bun.write(`${installed}/application/package.json`, '{"main":"index.js"}');
        await Bun.write(`${installed}/application/index.js`, 'export {installed} from "dep";');
        await Bun.write(`${installed}/dep/package.json`, '{"main":"index.js"}');
        await Bun.write(
          `${installed}/dep/index.js`,
          `export const installed = "${store === "first" ? "admitted" : "changed"}";`,
        );
      }
      await symlink(".bun/first/node_modules/application", `${cwd}/node_modules/application`);
    }
    const entered = `${root}/edit-${changed}-entered`;
    const release = `${root}/edit-${changed}-release`;
    await Bun.write(
      `${cwd}/count.test.ts`,
      `import { expect, test } from "bun:test";
import { count } from "./count.ts";
test("held", async () => {
  await Bun.write(${JSON.stringify(entered)}, "entered");
  while (!(await Bun.file(${JSON.stringify(release)}).exists())) await Bun.sleep(20);
  expect(count(1)).toBe(2);
}, 60_000);`,
    );
    await Bun.write(`${cwd}/data.txt`, "admitted");
    await Bun.write(`${cwd}/config.json`, '{"value":"admitted"}');
    await Bun.write(`${cwd}/dependency.ts`, 'export const dependency = "admitted";');
    await Bun.write(`${cwd}/later.ts`, "export function later(n: number) { return n + 2; }\n");
    expect(Bun.spawnSync(["git", "init", "-q", cwd]).exitCode).toBe(0);
    expect(
      Bun.spawnSync(
        ["git", "add", "count.ts", "later.ts", "dependency.ts", "config.json", "data.txt"],
        { cwd },
      ).exitCode,
    ).toBe(0);
    await Bun.write(
      `${cwd}/later.test.ts`,
      `import { expect, test } from "bun:test";
import { later } from "./later.ts";
import { dependency } from "./dependency.ts";
import { installed } from "application";
test("snapshot", async () => {
  expect(later(1)).toBe(3);
  expect(dependency).toBe("admitted");
  expect(installed).toBe("admitted");
  expect(await Bun.file("data.txt").text()).toBe("admitted");
  expect(await Bun.file("config.json").json()).toEqual({ value: "admitted" });
});`,
    );
    const run = start(cwd, ["count.ts", "later.ts"]);
    try {
      await waitFor(entered);
      if (changed === "source") {
        await Bun.write(`${cwd}/later.ts`, "export function later() { return 999; }\n");
        await Bun.write(`${cwd}/later.test.ts`, "process.exit(19);");
        await Bun.write(`${cwd}/dependency.ts`, 'export const dependency = "changed";');
        await Bun.write(`${cwd}/config.json`, '{"value":"changed"}');
        await Bun.write(`${cwd}/data.txt`, "changed");
      }
      if (changed === "alias") {
        await rm(`${cwd}/node_modules/application`);
        await symlink(".bun/second/node_modules/application", `${cwd}/node_modules/application`);
      } else
        await Bun.write(
          `${cwd}/node_modules/application/index.js`,
          'export const installed = "changed";',
        );
      await Bun.write(release, "go");
      const [code, stdout, stderr] = await run.result;
      expect(code, stdout + stderr).toBe(3);
      expect(stderr).toContain("inputs-changed");
      const state = await mutationStateDirectory(cwd);
      expect(await admissionReport(state)).toMatchObject({
        status: "inputs-changed",
        current: false,
      });
      const stale = await runEvidence(cwd);
      expect(stale.admission).toMatchObject({ current: false, reason: "inputs-changed" });
      expect(stale.state.status).toBe("incomplete");
      expect(stale.state.units.map((unit) => unit.status)).toEqual(["passed", "passed"]);
      const reports = await Array.fromAsync(new Bun.Glob("*/later.ts.json").scan(state));
      expect(reports).toHaveLength(1);
      const report = z
        .object({
          unit: z.object({ source: z.string() }),
          results: z.array(z.object({ status: z.string() })),
        })
        .parse(await Bun.file(`${state}/${reports[0]}`).json());
      expect(report.unit.source).toBe("export function later(n: number) { return n + 2; }\n");
      expect(report.results.map((result: { status: string }) => result.status)).toEqual([
        "Killed",
        "Killed",
      ]);
      expect(await Bun.file(`${cwd}/later.ts`).text()).toContain(
        changed === "source" ? "999" : "n + 2",
      );
    } finally {
      await run.stop();
    }
  },
);

test.each(["SIGINT", "SIGTERM", "SIGKILL"] as const)(
  "%s stops owned descendants, preserves completed evidence, and leaves unrelated processes alive",
  async (signal) => {
    const cwd = await fixture();
    const entered = `${root}/${signal}-pid`;
    await Bun.write(
      `${cwd}/count.test.ts`,
      'import { expect, test } from "bun:test"; import { count } from "./count.ts"; test("exact", () => expect(count(1)).toBe(2));',
    );
    await Bun.write(`${cwd}/later.ts`, "export function later(n: number) { return n + 2; }\n");
    await Bun.write(
      `${cwd}/later.test.ts`,
      `import { test } from "bun:test";
test("held", async () => {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  await Bun.write(${JSON.stringify(entered)}, JSON.stringify({ test: process.pid, descendant: child.pid }));
  await Bun.sleep(60000);
});`,
    );
    const unrelated = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const run = start(cwd, ["count.ts", "later.ts"]);
    try {
      await waitFor(entered);
      const owned = (await Bun.file(entered).json()) as { test: number; descendant: number };
      const state = await mutationStateDirectory(cwd);
      const completed = await Array.fromAsync(new Bun.Glob("*/count.ts.json").scan(state));
      expect(completed).toHaveLength(1);
      const evidence = await Bun.file(`${state}/${completed[0]}`).text();
      run.child.kill(signal);
      const [code, , stderr] = await finishedBeforeCleanup(run, 1000);
      expect(code).not.toBe(0);
      if (signal !== "SIGKILL") {
        expect(stderr).toContain("cancelled");
        expect(await admissionReport(state)).toMatchObject({ status: "cancelled", current: true });
      }
      for (const pid of [owned.test, owned.descendant]) {
        const deadline = Date.now() + 1000;
        function alive() {
          const status = Bun.spawnSync(["ps", "-p", String(pid), "-o", "stat="])
            .stdout.toString()
            .trim();
          return status !== "" && !status.startsWith("Z");
        }

        while (alive() && Date.now() < deadline) await Bun.sleep(20);
        expect(alive()).toBe(false);
      }
      expect(unrelated.exitCode).toBe(null);
      expect(process.kill(unrelated.pid, 0)).toBe(true);
      expect(await Bun.file(`${state}/${completed[0]}`).text()).toBe(evidence);
      const interrupted = await runEvidence(cwd);
      expect(interrupted.state.status).toBe("incomplete");
      expect(interrupted.state.units.map((unit) => unit.status)).toEqual(["passed", "interrupted"]);
      expect(interrupted.state.units[0]?.mutants?.map((mutant) => mutant.status)).toEqual([
        "Killed",
        "Killed",
      ]);
      expect(await Array.fromAsync(new Bun.Glob("*/later.ts.json").scan(state))).toEqual([]);
      if (signal === "SIGKILL") {
        const recovered = await start(cwd, ["--recover-claim"]).result;
        expect(recovered[0], recovered[2]).toBe(0);
        expect(recovered[1]).toContain("preserved");
      }
    } finally {
      await run.stop();
      await run.result;
      unrelated.kill();
      await unrelated.exited;
    }
  },
);

test("real independent Git worktrees do not share a campaign claim", async () => {
  const cwd = await fixture();
  const entered = `${root}/worktree-entered`;
  const release = `${root}/worktree-release`;
  // The independent run must outlast Bun's default test timeout without releasing the other claim.
  const ordinary =
    'import { expect, test } from "bun:test"; import { count } from "./count.ts"; test("exact", async () => { await Bun.sleep(6000); expect(count(1)).toBe(2); }, 30000);';
  await Bun.write(`${cwd}/count.test.ts`, ordinary);
  function git(...args: string[]) {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  }

  git("init", "-q");
  git("add", "count.ts", "count.test.ts", "package.json");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "fixture",
  );
  const other = `${root}/other-worktree`;
  git("worktree", "add", "--detach", other, "HEAD");
  await mkdir(`${other}/node_modules`);
  await Bun.write(
    `${cwd}/count.test.ts`,
    `import { expect, test } from "bun:test";
import { count } from "./count.ts";
test("held", async () => {
 await Bun.write(${JSON.stringify(entered)}, "entered");
 while (!(await Bun.file(${JSON.stringify(release)}).exists())) await Bun.sleep(20);
 expect(count(1)).toBe(2);
}, 60_000);`,
  );
  const first = start(cwd);
  try {
    await waitFor(entered);
    const independent = await start(other).result;
    expect(independent[0], independent[1] + independent[2]).toBe(0);
    const firstState = await mutationStateDirectory(cwd);
    const otherState = await mutationStateDirectory(other);
    expect(firstState).not.toBe(otherState);
    expect(await Bun.file(`${firstState}/claim/owner.json`).exists()).toBe(true);
    expect(await Bun.file(`${otherState}/claim/owner.json`).exists()).toBe(false);
    await Bun.write(release, "go");
    expect((await first.result)[0]).toBe(0);
  } finally {
    await first.stop();
    git("worktree", "remove", "--force", other);
  }
});

test("cancellation during admission never starts the engine or a test process", async () => {
  const cwd = await fixture();
  const receipt = `${root}/forbidden-admission-test`;
  await Bun.write(
    `${cwd}/count.test.ts`,
    `await Bun.write(${JSON.stringify(receipt)}, "forbidden");`,
  );
  for (let index = 0; index < 64; index++)
    await Bun.write(`${cwd}/large-${index}`, new Uint8Array(1_000_000));
  const preload = `${root}/claim-publication-preload.ts`;
  await Bun.write(
    preload,
    `const write = Bun.write;
Bun.write = async (file, ...args) => {
  const result = await write(file, ...args);
  if (typeof file === "string" && file.endsWith("/claim/owner.json")) await Bun.sleep(100);
  return result;
};`,
  );
  const state = await mutationStateDirectory(cwd);
  const run = start(cwd, ["count.ts"], script, preload);
  try {
    const deadline = Date.now() + 10_000;
    while (!(await Bun.file(`${state}/claim/owner.json`).exists()) && Date.now() < deadline)
      await Bun.sleep(1);
    expect(await Bun.file(`${state}/claim/owner.json`).exists()).toBe(true);
    run.child.kill("SIGTERM");
    const [code, , stderr] = await run.result;
    expect(code, stderr).toBe(3);
    expect(stderr).toContain("cancelled");
    expect(await Bun.file(receipt).exists()).toBe(false);
    expect(await admissionReport(state)).toMatchObject({ status: "cancelled", current: true });
    expect(await Bun.file(`${state}/claim/owner.json`).exists()).toBe(false);
  } finally {
    await run.stop();
  }
});

test("a repository-owned runner executes its admitted tooling copy rather than mutable checkout scripts", async () => {
  const cwd = await fixture("toolchain");
  const receipt = `${root}/tooling-copy`;
  for (const name of [
    "mutate",
    "mutation-campaign",
    "mutation-claim",
    "mutation-snapshot",
    "mutation-run",
    "mutation-selection",
    "mutation-policy",
    "mutation-admission",
    "mutation-evidence",
    "mutation-engine-progress",
    "mutation-worker",
    "mutation-plan",
    "mutation-budget",
    "mutation-preflight",
    "mutation-dependencies",
    "mutation-toolchain",
    "mutation-reuse",
    "mutation-resume",
  ])
    await Bun.write(`${cwd}/tools/${name}.ts`, Bun.file(`${import.meta.dir}/${name}.ts`));
  const worker = `${cwd}/tools/mutation-worker.ts`;
  await Bun.write(
    worker,
    `await Bun.write(${JSON.stringify(receipt)}, import.meta.path);\n${await Bun.file(worker).text()}`,
  );
  await Bun.write(
    `${cwd}/count.test.ts`,
    'import { expect, test } from "bun:test"; import { count } from "./count.ts"; test("exact", () => expect(count(1)).toBe(2));',
  );
  const run = start(cwd, ["count.ts"], `${cwd}/tools/mutate.ts`);
  const [code, stdout, stderr] = await run.result;
  expect(code, stdout + stderr).toBe(0);
  const observed = await Bun.file(receipt).text();
  expect(observed).not.toStartWith(cwd);
  expect(observed).toContain("/.mutation-");
  expect(observed).toEndWith("/tools/mutation-worker.ts");
});

test.each(["malformed", "foreign"])(
  "a %s worker message preserves valid evidence and cannot qualify",
  async (kind) => {
    const cwd = await fixture("protocol");
    for (const name of [
      "mutate",
      "mutation-campaign",
      "mutation-claim",
      "mutation-snapshot",
      "mutation-run",
      "mutation-selection",
      "mutation-policy",
      "mutation-admission",
      "mutation-evidence",
      "mutation-engine-progress",
      "mutation-plan",
      "mutation-budget",
      "mutation-resume",
    ])
      await Bun.write(`${cwd}/tools/${name}.ts`, Bun.file(`${import.meta.dir}/${name}.ts`));
    await Bun.write(`${cwd}/count.test.ts`, "");
    await Bun.write(
      `${cwd}/tools/mutation-worker.ts`,
      `
const {value} = await Bun.stdin.stream().getReader().read();
const input = JSON.parse(new TextDecoder().decode(value));
const event = {
  version: 1, runId: input.token, sequence: 0, type: "unit-completed", elapsedMs: 1,
  state: {status: "running", activeUnit: null, completedUnits: 1, skipped: 0, units: [{
    name: "count.ts", tests: ["./count.test.ts"], patterns: ["count.ts"], status: "passed",
    mutants: [{id: "owned", status: "Killed", mutatorName: "ArithmeticOperator",
      location: {start: {line: 1, column: 1}, end: {line: 1, column: 2}}, replacement: "-"}],
    progress: {completed: 1, total: 1, reused: 0}
  }]}
};
process.send(event);
process.send(${kind === "foreign" ? '{...event, runId: "foreign", type: "run-completed", state: {...event.state, status: "passed", units: []}}' : '{...event, type: "run-completed", state: {...event.state, status: "passed", units: [{...event.state.units[0], mutants: [{status: "Killed"}]}]}}'});
process.on("message", () => process.exit(0));
setTimeout(() => process.exit(0), 1000);
`,
    );
    const [code, stdout, stderr] = await start(
      cwd,
      ["--json", "count.ts"],
      `${cwd}/tools/mutate.ts`,
    ).result;
    expect(code, stdout + stderr).toBe(3);
    expect(stderr).toContain("Invalid mutation worker event");
    const evidence = await runEvidence(cwd);
    expect(evidence.state.status).toBe("incomplete");
    expect(evidence.state.units).toHaveLength(1);
    expect(evidence.state.units[0]?.mutants).toEqual([
      {
        id: "owned",
        status: "Killed",
        mutatorName: "ArithmeticOperator",
        location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
        replacement: "-",
      },
    ]);
  },
);

const decisionRoot = await mkdtemp(`${tmpdir()}/mutation-campaign-`);
afterAll(async () => rm(decisionRoot, { recursive: true, force: true }));
afterEach(() => mock.restore());

async function campaign(
  decisionRoot: string,
  selected: { units: MutationUnit[]; skipped: number },
  identity: string,
) {
  const deadline = setTimeout(() => {
    process.emit("SIGTERM");
  }, 1000);
  try {
    return await runMutationCampaign(decisionRoot, selected, identity);
  } finally {
    clearTimeout(deadline);
  }
}

test("campaign admission refuses a stale selection before launching a worker", async () => {
  const output = spyOn(console, "error").mockImplementation(() => {});
  await Bun.write(`${decisionRoot}/input.ts`, "admitted");
  const identity = await mutationInputIdentity(decisionRoot);
  await Bun.write(`${decisionRoot}/input.ts`, "changed");
  expect(await campaign(decisionRoot, { units: [], skipped: 0 }, identity)).toBe(3);
  const state = await mutationStateDirectory(decisionRoot);
  expect(await Array.fromAsync(new Bun.Glob("*.json").scan(state))).toEqual([]);
  expect(await Bun.file(`${state}/claim/owner.json`).exists()).toBe(false);
  expect(output.mock.calls).toEqual([["Mutation inputs changed during selection."]]);
  output.mockRestore();
});

test("campaigns bind qualification to their snapshot and release their claim", async () => {
  const identity = await mutationInputIdentity(decisionRoot);
  const handlers = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  expect(await campaign(decisionRoot, { units: [], skipped: 2 }, identity)).toBe(0);
  const state = await mutationStateDirectory(decisionRoot);
  const names = await Array.fromAsync(new Bun.Glob("*.json").scan(state));
  expect(names).toHaveLength(1);
  expect(
    z
      .object({
        version: z.literal(1),
        identity: z.string(),
        current: z.boolean(),
        status: z.string(),
        code: z.number(),
      })
      .parse(await Bun.file(`${state}/${names[0]}`).json()),
  ).toEqual({
    version: 1,
    identity,
    current: true,
    status: "qualified",
    code: 0,
  });
  expect(await Bun.file(`${state}/claim/owner.json`).exists()).toBe(false);
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(handlers);
});

test("a busy worktree refuses without overwriting completed reports", async () => {
  const state = await mutationStateDirectory(decisionRoot);
  const claim = await acquireMutationClaim(state);
  if ("error" in claim) return expect.unreachable("fixture claim failed");
  const reports = await Array.fromAsync(new Bun.Glob("*.json").scan(state));
  expect(
    await campaign(
      decisionRoot,
      { units: [], skipped: 0 },
      await mutationInputIdentity(decisionRoot),
    ),
  ).toBe(3);
  expect(await Array.fromAsync(new Bun.Glob("*.json").scan(state))).toEqual(reports);
  await claim.release();
});

test("a selected source mismatch refuses without running or deleting the source", async () => {
  const output = spyOn(console, "error").mockImplementation(() => {});
  await Bun.write(`${decisionRoot}/selected.ts`, "actual");
  const identity = await mutationInputIdentity(decisionRoot);
  expect(
    await campaign(
      decisionRoot,
      {
        units: [{ name: "selected.ts", source: "stale", tests: [], patterns: ["selected.ts"] }],
        skipped: 0,
      },
      identity,
    ),
  ).toBe(3);
  expect(await Bun.file(`${decisionRoot}/selected.ts`).text()).toBe("actual");
  expect(output.mock.calls).toEqual([["Mutation inputs changed during selection."]]);
  output.mockRestore();
});

test("a nonqualifying worker outcome is failed evidence, not qualification", async () => {
  const cwd = `${decisionRoot}/failed`;
  await Bun.write(`${cwd}/count.ts`, "actual");
  const state = await mutationStateDirectory(cwd);
  expect(
    await campaign(
      cwd,
      {
        units: [{ name: "count.ts", source: "actual", tests: [], patterns: ["count.ts"] }],
        skipped: 0,
      },
      await mutationInputIdentity(cwd),
    ),
  ).toBe(2);
  const reports = await Array.fromAsync(new Bun.Glob("*.json").scan(state));
  expect(reports).toHaveLength(1);
  expect(
    z
      .object({ status: z.string(), code: z.number(), current: z.boolean() })
      .parse(await Bun.file(`${state}/${reports[0]}`).json()),
  ).toEqual({
    status: "failed",
    code: 2,
    current: true,
  });
});

test("a selection that misses admitted beside-tests refuses instead of qualifying a transient test list", async () => {
  const cwd = `${decisionRoot}/test-list`;
  await Bun.write(`${cwd}/count.ts`, "actual");
  await Bun.write(`${cwd}/count.test.ts`, "process.exit(91);");
  expect(
    await campaign(
      cwd,
      {
        units: [{ name: "count.ts", source: "actual", tests: [], patterns: ["count.ts"] }],
        skipped: 0,
      },
      await mutationInputIdentity(cwd),
    ),
  ).toBe(3);
  expect(
    await Array.fromAsync(new Bun.Glob(".mutation-runs/*.json").scan({ cwd, dot: true })),
  ).toEqual([]);
});

test("a selected unit missing from the admitted copy refuses before worker execution", async () => {
  const cwd = `${decisionRoot}/missing-unit`;
  await Bun.write(`${cwd}/retained.txt`, "unrelated");
  expect(
    await campaign(
      cwd,
      {
        units: [{ name: "missing.ts", source: "actual", tests: [], patterns: ["missing.ts"] }],
        skipped: 0,
      },
      await mutationInputIdentity(cwd),
    ),
  ).toBe(3);
  expect(await Bun.file(`${cwd}/retained.txt`).text()).toBe("unrelated");
  expect(
    await Array.fromAsync(new Bun.Glob(".mutation-runs/*.json").scan({ cwd, dot: true })),
  ).toEqual([]);
});

test("a real ownership-record write failure cancels a started worker before releasing resources", async () => {
  const cwd = await fixture();
  for (let index = 0; index < 64; index++)
    await Bun.write(`${cwd}/large-${index}`, new Uint8Array(1_000_000));
  await Bun.write(`${cwd}/count.test.ts`, "process.exit(91);");
  const state = await mutationStateDirectory(cwd);
  const run = start(cwd);
  try {
    const deadline = Date.now() + 10_000;
    const file = `${state}/claim/owner.json`;
    while (!(await Bun.file(file).exists()) && Date.now() < deadline) await Bun.sleep(1);
    expect(await Bun.file(file).exists()).toBe(true);
    await rm(file);
    await import("node:fs/promises").then((fs) => fs.mkdir(file));
    const [code, stdout, stderr] = await finishedBeforeCleanup(run, 2000);
    expect(code, stdout + stderr).toBe(3);
    expect(stderr).toContain("Mutation execution incomplete:");
    expect(
      await Array.fromAsync(new Bun.Glob(".mutation-*").scan({ cwd, onlyFiles: false })),
    ).toEqual([]);
  } finally {
    await run.stop();
    await rm(state, { recursive: true, force: true });
  }
});
