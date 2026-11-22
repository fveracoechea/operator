import { runMutationCampaign } from "./mutation-campaign.ts";
import { mutationInputIdentity } from "./mutation-snapshot.ts";
import type { MutationUnit } from "./mutation-selection.ts";
import { afterAll, afterEach, expect, mock, setDefaultTimeout, spyOn, test } from "bun:test";
// Bun has no temporary-directory, symbolic-link, or recursive removal API.
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { acquireMutationClaim, mutationStateDirectory } from "./mutation-claim.ts";
import { z } from "zod";
import { mutationBudget } from "./mutation-budget.ts";

setDefaultTimeout(60_000);
const root = await mkdtemp("/tmp/opencode/mutation-ownership-");
const script = `${import.meta.dir}/mutate.ts`;
afterAll(async () => rm(root, { recursive: true, force: true }));

async function fixture() {
  const cwd = `${root}/${crypto.randomUUID()}`;
  await Bun.write(
    `${cwd}/package.json`,
    JSON.stringify({ type: "module", scripts: { test: "bun test --isolate" } }),
  );
  await Bun.write(`${cwd}/count.ts`, "export function count(n: number) { return n + 1; }\n");
  await symlink(`${import.meta.dir}/../node_modules`, `${cwd}/node_modules`);
  return cwd;
}

function signalFixtureGroup(group: number) {
  try {
    process.kill(-group, "SIGKILL");
  } catch (error) {
    expect(z.object({ code: z.literal("ESRCH") }).safeParse(error).success).toBe(true);
  }
}

function start(cwd: string, args = ["count.ts"], entry = script) {
  const state = mutationStateDirectory(cwd);
  const child = Bun.spawn([process.execPath, entry, ...args], {
    cwd,
    detached: true,
    stdout: "pipe",
    stderr: "pipe",
  });
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
  }, 5000);
  const result = Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(deadline));
  return { child, result, stop };
}

async function waitFor(file: string) {
  const deadline = Date.now() + 3000;
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
import {count} from "./count.ts"; test("count", () => expect(count(1)).toBe(2));`,
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
  const run = start(cwd, ["--json", "--budget", "2.5", "count.ts", "held.ts", "later.ts"]);
  try {
    const [code, stdout, stderr] = await finishedBeforeCleanup(run, 4500);
    expect(code, stdout + stderr).toBe(3);
    expect(await Bun.file(entered).exists()).toBe(true);
    expect(await Bun.file(forbidden).exists()).toBe(false);
    expect(stderr).toContain("budget-exhausted");
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
    await run.stop();
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
  const cwd = await fixture();
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
  const run = start(cwd, ["--json", "--budget", "1", "count.ts"], `${cwd}/tools/mutate.ts`);
  try {
    const [code, stdout, stderr] = await finishedBeforeCleanup(run, 2500);
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
});`,
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
      await Array.fromAsync(new Bun.Glob(".mutation-*").scan({ cwd, onlyFiles: false })),
    ).toEqual([".mutation-incremental", ".mutation-runs"]);
  } finally {
    await first.stop();
  }
});

test("all units retain admitted tracked, imported, fixture, config, and untracked test inputs after edits", async () => {
  const cwd = await fixture();
  const entered = `${root}/edit-entered`;
  const release = `${root}/edit-release`;
  await Bun.write(
    `${cwd}/count.test.ts`,
    `import { expect, test } from "bun:test";
import { count } from "./count.ts";
test("held", async () => {
  await Bun.write(${JSON.stringify(entered)}, "entered");
  while (!(await Bun.file(${JSON.stringify(release)}).exists())) await Bun.sleep(20);
  expect(count(1)).toBe(2);
});`,
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
test("snapshot", async () => {
  expect(later(1)).toBe(3);
  expect(dependency).toBe("admitted");
  expect(await Bun.file("data.txt").text()).toBe("admitted");
  expect(await Bun.file("config.json").json()).toEqual({ value: "admitted" });
});`,
  );
  const run = start(cwd, ["count.ts", "later.ts"]);
  try {
    await waitFor(entered);
    await Bun.write(`${cwd}/later.ts`, "export function later() { return 999; }\n");
    await Bun.write(`${cwd}/later.test.ts`, "process.exit(19);");
    await Bun.write(`${cwd}/dependency.ts`, 'export const dependency = "changed";');
    await Bun.write(`${cwd}/config.json`, '{"value":"changed"}');
    await Bun.write(`${cwd}/data.txt`, "changed");
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
    expect(await Bun.file(`${cwd}/later.ts`).text()).toContain("999");
  } finally {
    await run.stop();
  }
});

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
  const ordinary =
    'import { expect, test } from "bun:test"; import { count } from "./count.ts"; test("exact", () => expect(count(1)).toBe(2));';
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
  await symlink(`${import.meta.dir}/../node_modules`, `${other}/node_modules`);
  await Bun.write(
    `${cwd}/count.test.ts`,
    `import { expect, test } from "bun:test";
import { count } from "./count.ts";
test("held", async () => {
 await Bun.write(${JSON.stringify(entered)}, "entered");
 while (!(await Bun.file(${JSON.stringify(release)}).exists())) await Bun.sleep(20);
 expect(count(1)).toBe(2);
});`,
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
  const state = await mutationStateDirectory(cwd);
  const run = start(cwd);
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
  const cwd = await fixture();
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
  expect(observed).toStartWith(`${cwd}/.mutation-`);
  expect(observed).toEndWith("/snapshot/tools/mutation-worker.ts");
});

const decisionRoot = await mkdtemp("/tmp/opencode/mutation-campaign-");
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
