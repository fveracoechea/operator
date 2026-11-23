import { afterAll, expect, test } from "bun:test";
// Bun has no temporary-directory, metadata, or recursive removal API.
import { mkdtemp, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { mutationEventSchema } from "./mutation-run.ts";

const root = await mkdtemp("/tmp/opencode/mutation-worker-protocol-");
afterAll(() => rm(root, { recursive: true, force: true }));
const point = { line: 1, column: 1 };
const killed = {
  id: "one",
  status: "Killed",
  mutatorName: "BooleanLiteral",
  location: { start: point, end: point },
  replacement: "false",
};
const tested = {
  name: "tested.ts",
  source: "export const value = true;",
  patterns: ["tested.ts"],
  tests: ["./tested.test.ts"],
};
const untested = { name: "untested.ts", source: "", patterns: ["untested.ts"], tests: [] };
let failedExchange: unknown;

async function protocol(
  options: {
    preflight?: boolean;
    damaged?: boolean;
    uncertain?: boolean;
    reuse?: boolean;
    drift?: "during" | "after" | "throw" | "before" | "no-terminal";
    mixed?: boolean;
  } = {},
) {
  // A broken protocol must fail the remaining cases, not spend another deadline per case.
  expect(failedExchange, "an earlier worker admission/IPC/exit exchange failed").toBeUndefined();
  const cwd = `${root}/${crypto.randomUUID()}`;
  await Bun.write(`${cwd}/worker.ts`, Bun.file(`${import.meta.dir}/mutation-worker.ts`));
  await symlink(
    path.dirname(path.dirname(Bun.resolveSync("zod/package.json", import.meta.dir))),
    `${cwd}/node_modules`,
  );
  for (const name of [
    "mutation-run",
    "mutation-admission",
    "mutation-preflight",
    "mutation-plan",
    "mutation-evidence",
    "mutation-policy",
  ])
    await Bun.write(`${cwd}/${name}.ts`, Bun.file(`${import.meta.dir}/${name}.ts`));
  await Bun.write(
    `${cwd}/controls.ts`,
    `
export const options = ${JSON.stringify(options)};
export const killed = ${JSON.stringify(killed)};
export function receipt(call, ...args) { console.error("CONTROL " + JSON.stringify([call, ...args])); }
`,
  );
  await Bun.write(
    `${cwd}/mutation-toolchain.ts`,
    `
import {options, receipt} from "./controls.ts";
let calls = 0;
export async function mutationToolchainIdentity() {
  calls++;
  receipt("toolchain", calls);
  return (((options.drift === "during" || options.drift === "no-terminal") && calls >= 2) || (options.drift === "after" && calls >= 3)) ? "changed" : "toolchain";
}
`,
  );
  await Bun.write(
    `${cwd}/mutation-dependencies.ts`,
    `
import {options, receipt} from "./controls.ts";
export async function mutationUnitIdentity(root, unit, toolchain) {
  receipt("identity", root, unit.name, toolchain);
  if (options.drift === "before") throw new Error("identity unavailable");
   return options.uncertain
     ? {eligible: false, reason: "unsupported-test-command"}
     : {eligible: true, identity: "unit-identity"};
}
`,
  );
  await Bun.write(
    `${cwd}/mutation-reuse.ts`,
    `
import {options, receipt, killed} from "./controls.ts";
import {z} from "zod";
export const mutationReuseSchema = z.discriminatedUnion("eligible", [
  z.object({eligible: z.literal(false), reason: z.enum(["unsupported-test-command", "uncertain-inputs", "unreadable-inputs"]), lookup: z.literal("not-checked")}),
  z.object({eligible: z.literal(true), identity: z.string(), lookup: z.enum(["hit", "miss", "unusable", "inputs-changed"])}),
]);
export async function mutationReuseDecision(root, identity) {
  if (!identity.eligible) return {decision: {...identity, lookup: "not-checked"}};
  receipt("read", root, identity.identity);
  return {decision: {...identity, lookup: options.reuse ? "hit" : options.damaged ? "unusable" : "miss"}, results: options.reuse ? [killed] : undefined};
}
export async function saveMutationReuse(root, identity, results) { receipt("save", root, identity, results); }
`,
  );
  await Bun.write(
    `${cwd}/mutate.ts`,
    `
import {receipt, killed} from "./controls.ts";
export async function executeMutationUnit(unit, progress, root, machine, identity, preflight) {
  receipt("execute", unit.name, root, machine, identity, preflight);
  return [killed];
}
`,
  );
  if (options.drift === "throw") {
    await Bun.write(`${cwd}/scheduler.ts`, Bun.file(`${cwd}/mutation-run.ts`));
    await Bun.write(
      `${cwd}/mutation-run.ts`,
      `
export * from "./scheduler.ts";
import {runMutationUnits as run} from "./scheduler.ts";
export async function runMutationUnits(...args) {
  await run(...args);
  throw new Error("scheduler failed after terminal");
}
`,
    );
  }
  if (options.drift === "no-terminal") {
    await Bun.write(`${cwd}/scheduler.ts`, Bun.file(`${cwd}/mutation-run.ts`));
    await Bun.write(
      `${cwd}/mutation-run.ts`,
      'export * from "./scheduler.ts"; export async function runMutationUnits() { return 0; }',
    );
  }
  if (options.damaged) await Bun.write(`${cwd}/.mutation-reuse/unit-identity.json`, "damaged");
  const events: unknown[] = [];
  const started = Date.now();
  const child = Bun.spawn([process.execPath, `${cwd}/worker.ts`], {
    cwd,
    detached: true,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    ipc(event) {
      events.push(event);
      if (mutationEventSchema.safeParse(event).data?.type === "run-completed") child.send({});
    },
  });
  const stdoutText = new Response(child.stdout).text();
  const stderrText = new Response(child.stderr).text();
  const deadline = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => deadline.resolve(undefined), 2000);
  try {
    const exchange = (async () => {
      await child.stdin.write(
        JSON.stringify({
          root: cwd,
          state: `${cwd}/state`,
          token: "token",
          identity: "admitted",
          json: true,
          preflight: options.preflight ?? false,
          keepGoing: true,
          selected: { units: options.mixed ? [tested, untested] : [tested], skipped: 0 },
        }) + "\n",
      );
      await child.stdin.flush();
      return Promise.all([child.exited, stdoutText, stderrText]);
    })();
    const completed = await Promise.race([exchange, deadline.promise]);
    if (completed === undefined)
      expect.unreachable(
        `worker must consume admission, acknowledge terminal IPC and exit within 2000ms; received ${events.length} events`,
      );
    const [code, stdout, stderr] = completed;
    const calls = stderr
      .split("\n")
      .filter((line) => line.startsWith("CONTROL "))
      .map((line) => z.array(z.unknown()).parse(JSON.parse(line.slice(8))));
    return {
      cwd,
      code,
      stdout,
      stderr,
      calls,
      events: events.map((event) => mutationEventSchema.parse(event)),
      elapsed: Date.now() - started,
    };
  } catch (error) {
    failedExchange = error;
    // oxlint-disable-next-line unthrown/no-throw -- Preserve the test assertion while failing later exchanges immediately.
    throw error;
  } finally {
    clearTimeout(timer);
    // This detached group belongs only to this exchange, including any fixture descendants.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      expect(z.object({ code: z.literal("ESRCH") }).safeParse(error).success).toBe(true);
    }
    child.disconnect();
    const reaped = Promise.withResolvers<boolean>();
    const cleanupTimer = setTimeout(() => reaped.resolve(false), 500);
    try {
      expect(
        await Promise.race([
          Promise.all([child.stdin.end(), child.exited, stdoutText, stderrText]).then(() => true),
          reaped.promise,
        ]),
        "the owned worker must exit and release its admission/output pipes after cleanup",
      ).toBe(true);
    } finally {
      clearTimeout(cleanupTimer);
    }
  }
}

test("a mixed selection fingerprints tested work, persists results and reuses validated evidence", async () => {
  const result = await protocol({ mixed: true });
  expect(result.code, result.stderr).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.calls).toEqual([
    ["toolchain", 1],
    ["identity", result.cwd, "tested.ts", "toolchain"],
    ["identity", result.cwd, "untested.ts", "toolchain"],
    ["read", result.cwd, "unit-identity"],
    ["execute", "tested.ts", result.cwd, true, "unit-identity", false],
    ["toolchain", 2],
    ["save", result.cwd, "unit-identity", [killed]],
    ["toolchain", 3],
  ]);
  expect(await Bun.file(`${result.cwd}/state/token/tested.ts.json`).json()).toEqual({
    unit: tested,
    results: [killed],
  });
  const reused = await protocol({ reuse: true });
  expect(reused.code, reused.stderr).toBe(0);
  expect(reused.calls).toEqual([
    ["toolchain", 1],
    ["identity", reused.cwd, "tested.ts", "toolchain"],
    ["read", reused.cwd, "unit-identity"],
    ["toolchain", 2],
  ]);
  expect(reused.events.at(-1)?.state.units[0]?.status).toBe("reused");
  expect(await Bun.file(`${reused.cwd}/state/token/tested.ts.json`).exists()).toBe(false);
});

test.each([{ damaged: true }, { uncertain: true }])(
  "damaged or uncertain reuse gets a fresh incremental identity: %j",
  async (options) => {
    const result = await protocol(options);
    expect(result.code, result.stderr).toBe(0);
    expect(result.calls).toContainEqual([
      "execute",
      "tested.ts",
      result.cwd,
      true,
      "admitted.toolchain.token",
      false,
    ]);
    expect(result.calls).toContainEqual([
      "save",
      result.cwd,
      options.uncertain ? null : "unit-identity",
      [killed],
    ]);
  },
);

test("preflight reports reuse eligibility but executes the baseline regardless of cache", async () => {
  const result = await protocol({ preflight: true });
  expect(result.code, result.stderr).toBe(3);
  expect(result.calls).toEqual([
    ["toolchain", 1],
    ["identity", result.cwd, "tested.ts", "toolchain"],
    ["read", result.cwd, "unit-identity"],
    ["execute", "tested.ts", result.cwd, true, "unit-identity", true],
    ["toolchain", 2],
  ]);
  expect(result.events.at(-1)).toMatchObject({
    mode: "preflight",
    state: { status: "incomplete" },
  });
});

test("toolchain changes during execution refuse persistence and report the reason", async () => {
  const result = await protocol({ drift: "during" });
  expect(result.code, result.stderr).toBe(3);
  expect(result.stderr).toContain("Mutation toolchain changed during execution.");
  expect(result.calls).not.toContainEqual(["save", result.cwd, "unit-identity", [killed]]);
  expect(result.events.at(-1)?.state.status).toBe("incomplete");
});

test("an identity failure before scheduler events exits incomplete without inventing terminal evidence", async () => {
  const result = await protocol({ drift: "before" });
  expect(result.code, result.stderr).toBe(3);
  expect(result.events).toEqual([]);
  expect(result.stderr).toContain("identity unavailable");
  expect(result.stderr).not.toContain("TypeError");
  expect(await Bun.file(`${result.cwd}/state/token/tested.ts.json`).exists()).toBe(false);
});

test("a scheduler returning without terminal evidence cannot turn toolchain drift into success", async () => {
  const result = await protocol({ drift: "no-terminal" });
  expect(result.code, result.stderr).toBe(3);
  expect(result.events).toEqual([]);
  expect(result.stderr).not.toContain("Mutation execution incomplete:");
  expect(result.calls).toEqual([
    ["toolchain", 1],
    ["identity", result.cwd, "tested.ts", "toolchain"],
    ["toolchain", 2],
  ]);
});

test.each(["after", "throw"] as const)(
  "terminal evidence becomes incomplete after %s failure",
  async (drift) => {
    const result = await protocol({ drift });
    expect(result.code, result.stderr).toBe(3);
    const terminal = result.events.at(-1);
    expect(terminal).toMatchObject({
      type: "run-completed",
      runId: "token",
      admission: {
        identity: "admitted",
        current: drift === "after" ? false : null,
        reason: "inputs-changed",
      },
      state: { status: "incomplete" },
    });
    expect(terminal?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(terminal?.elapsedMs).toBeLessThanOrEqual(result.elapsed);
  },
);
