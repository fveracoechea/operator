import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { Environment } from "../src/modules/environment/main.ts";
// Bun has no file-mode, metadata, recursive copy, or temporary-directory API.
import { chmod, cp, lstat, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { acquireMutationClaim, mutationStateDirectory } from "./mutation-claim.ts";
import { mutationEventSchema } from "./mutation-run.ts";

// Most tests run Stryker, which starts several Bun processes, so a busy machine needs time.
setDefaultTimeout(60_000);
// The real path, because Bun reports a script path with symlinks such as macOS /var resolved.
const root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-mutate-")));
const script = path.join(import.meta.dir, "mutate.ts");

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function mutate(cwd: string, args: string[], entry = script, preload?: string) {
  const child = Bun.spawn(
    [process.execPath, ...(preload ? ["--preload", preload] : []), entry, ...args],
    {
      cwd,
      env: {
        ...Environment.child(),
        HOME: root,
        XDG_CONFIG_HOME: `${root}/config`,
        XDG_STATE_HOME: `${root}/state`,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function fixture(files: Record<string, string>): Promise<string> {
  const cwd = path.join(root, crypto.randomUUID());
  await Bun.write(
    path.join(cwd, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: { test: "bun test --isolate" },
    }),
  );
  await mkdir(path.join(cwd, "node_modules"));
  await Promise.all(
    Object.entries(files).map(([name, text]) => Bun.write(path.join(cwd, name), text)),
  );
  return cwd;
}

function git(cwd: string, ...args: string[]): string {
  const child = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...Environment.child(),
      HOME: root,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.test",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.exitCode).toBe(0);
  return child.stdout.toString().trim();
}

async function refusalFixture(receipt: string) {
  const cwd = await fixture({
    "count.ts": "export const count = 1;\n",
    "count.test.ts": `await Bun.write(${JSON.stringify(receipt)}, "forbidden test");`,
  });
  for await (const name of new Bun.Glob("mutation*.ts").scan(import.meta.dir))
    if (!name.endsWith(".test.ts"))
      await Bun.write(`${cwd}/tools/${name}`, Bun.file(`${import.meta.dir}/${name}`));
  await Bun.write(`${cwd}/tools/mutate.ts`, Bun.file(script));
  await Bun.write(
    `${cwd}/tools/mutation-worker.ts`,
    `await Bun.write(${JSON.stringify(receipt)}, "forbidden worker"); process.exit(91);`,
  );
  for (const name of ["zod", "@babel/parser"])
    await cp(
      path.dirname(Bun.resolveSync(`${name}/package.json`, import.meta.dir)),
      `${cwd}/node_modules/${name}`,
      { recursive: true, dereference: true },
    );
  git(cwd, "init", "-q");
  return cwd;
}

test.each(["copy-drift", "untagged-error", "non-error-cause", "post-admission-tag"] as const)(
  "public JSON admission classifies only a tagged Error during %s",
  async (mode) => {
    const receipt = `${root}/${crypto.randomUUID()}-forbidden-worker`;
    const cwd = await refusalFixture(receipt);
    const state = await mutationStateDirectory(cwd);
    const checkpoint = `${root}/${crypto.randomUUID()}-copy.json`;
    const preload = `${root}/${crypto.randomUUID()}-copy-edit.ts`;
    await Bun.write(
      preload,
      `
import path from "node:path";
const write = Bun.write;
Bun.write = async (file, data, ...options) => {
  const result = await write(file, data, ...options);
  if (typeof file === "string" && file.endsWith("/count.ts") && file !== ${JSON.stringify(`${cwd}/count.ts`)}) {
    await write(${JSON.stringify(checkpoint)}, JSON.stringify({
      directory: path.dirname(file), copied: await Bun.file(file).text()
    }));
    if (${JSON.stringify(mode)} === "untagged-error")
      throw new Error("Mutation inputs changed during snapshot admission.");
    if (${JSON.stringify(mode)} === "non-error-cause") throw {cause: "inputs-changed"};
    if (${JSON.stringify(mode)} === "copy-drift")
      await write(${JSON.stringify(`${cwd}/count.ts`)}, "changed during copy");
  }
  if (${JSON.stringify(mode)} === "post-admission-tag" && typeof file === "string" &&
      file.startsWith(${JSON.stringify(`${state}/`)}) && typeof data === "string" && JSON.parse(data).status === "running") {
    throw new Error("failure after admission", {cause: "inputs-changed"});
  }
  return result;
};
`,
    );
    const result = await mutate(cwd, ["--json", "count.ts"], `${cwd}/tools/mutate.ts`, preload);
    expect(result.code, result.stderr).toBe(3);
    const copied = z
      .object({ directory: z.string(), copied: z.string() })
      .parse(await Bun.file(checkpoint).json());
    expect(copied.copied).toBe("export const count = 1;\n");
    if (mode === "copy-drift") {
      expect(await Bun.file(`${cwd}/count.ts`).text()).toBe("changed during copy");
      expect(result.stdout.trim().split("\n")).toEqual([
        JSON.stringify({ version: 1, type: "refusal", reason: "inputs-changed", code: 3 }),
      ]);
      expect(result.stderr).toContain("Mutation inputs changed during snapshot admission.");
    } else expect(result.stdout).toBe("");
    expect(await Bun.file(receipt).exists()).toBe(false);
    expect(await Bun.file(`${state}/claim/owner.json`).exists()).toBe(false);
    const reports = await Array.fromAsync(new Bun.Glob("*.json").scan(state));
    if (mode === "post-admission-tag") {
      expect(reports).toHaveLength(1);
      expect(await Bun.file(`${state}/${reports[0]}`).json()).toMatchObject({ status: "running" });
    } else expect(reports).toEqual([]);
    expect(
      await Array.fromAsync(new Bun.Glob(".mutation-runs/*").scan({ cwd, dot: true })),
    ).toEqual([]);
    await expect(lstat(copied.directory)).rejects.toHaveProperty("code", "ENOENT");
  },
);

test.each(["worktree-busy", "budget-exhausted"] as const)(
  "public JSON refusal reports %s without changing ownership or launching work",
  async (reason) => {
    const receipt = `${root}/${crypto.randomUUID()}-forbidden-worker`;
    const cwd = await refusalFixture(receipt);
    const state = await mutationStateDirectory(cwd);
    const claim = await acquireMutationClaim(state);
    if ("error" in claim) return expect.unreachable(claim.error);
    try {
      const owner = await Bun.file(`${state}/claim/owner.json`).text();
      const result = await mutate(
        cwd,
        [
          "--json",
          ...(reason === "budget-exhausted" ? ["--budget", "0.000000001"] : []),
          "count.ts",
        ],
        `${cwd}/tools/mutate.ts`,
      );
      expect(result.code, result.stderr).toBe(3);
      expect(
        result.stdout
          .trim()
          .split("\n")
          .map((line) =>
            z
              .strictObject({
                version: z.literal(1),
                type: z.literal("refusal"),
                reason: z.literal(reason),
                code: z.literal(3),
              })
              .parse(JSON.parse(line)),
          ),
      ).toEqual([{ version: 1, type: "refusal", reason, code: 3 }]);
      expect(result.stderr).toContain(
        reason === "worktree-busy" ? "Mutation worktree busy." : "budget-exhausted",
      );
      expect(await Bun.file(`${state}/claim/owner.json`).text()).toBe(owner);
      expect(await Bun.file(receipt).exists()).toBe(false);
      expect(await Array.fromAsync(new Bun.Glob(".mutation-*").scan({ cwd, dot: true }))).toEqual(
        [],
      );
      expect(await Array.fromAsync(new Bun.Glob("*.json").scan(state))).toEqual([]);
    } finally {
      await claim.release();
    }
  },
);

test("public JSON completion is not duplicated by a refusal after campaign handoff fails", async () => {
  const receipt = `${root}/${crypto.randomUUID()}-forbidden-worker`;
  const cwd = await refusalFixture(receipt);
  const state = await mutationStateDirectory(cwd);
  const preload = `${root}/${crypto.randomUUID()}-report-failure.ts`;
  await Bun.write(
    preload,
    `
import {rm, mkdir} from "node:fs/promises";
let clock = 0;
performance.now = () => clock;
const write = Bun.write;
Bun.write = async (file, data, ...options) => {
  const result = await write(file, data, ...options);
  if (typeof file === "string" && file.startsWith(${JSON.stringify(`${state}/`)}) &&
      typeof data === "string" && JSON.parse(data).status === "running") {
    await rm(file);
    await mkdir(file);
    clock = 60000;
  }
  return result;
};
`,
  );
  const result = await mutate(
    cwd,
    ["--json", "--budget", "60", "count.ts"],
    `${cwd}/tools/mutate.ts`,
    preload,
  );
  expect(result.code, result.stderr).toBe(3);
  expect(result.stderr).toContain("EISDIR");
  const events = result.stdout
    .trim()
    .split("\n")
    .map((line) => mutationEventSchema.parse(JSON.parse(line)));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "run-completed",
    admission: { current: null, reason: "budget-exhausted" },
    state: { status: "incomplete", units: [{ status: "unrun" }] },
  });
  expect(await Bun.file(receipt).exists()).toBe(false);
  expect(await Bun.file(`${state}/claim/owner.json`).exists()).toBe(false);
});

test("external snapshot edits invalidate passing reuse without invalidating unrelated units", async () => {
  const cwd = await fixture({
    "count.ts": "export const count = 1;\n",
    "count.test.ts":
      'import {expect,test} from "bun:test"; import {count} from "./count.ts"; test("count", () => expect(count).toMatchSnapshot());',
    "other.ts": "export const other = 2;\n",
    "other.test.ts":
      'import {expect,test} from "bun:test"; import {other} from "./other.ts"; test("other", () => expect(other).toBe(2));',
  });
  function ordinary() {
    return Bun.spawnSync([process.execPath, "test", "./count.test.ts"], { cwd });
  }

  const initialized = Bun.spawnSync(
    [process.execPath, "test", "--update-snapshots", "./count.test.ts"],
    { cwd },
  );
  expect(initialized.exitCode, initialized.stderr.toString()).toBe(0);
  expect(ordinary().exitCode).toBe(0);
  const first = await mutate(cwd, ["--json", "count.ts", "other.ts"]);
  expect(first.code, first.stderr).toBe(0);
  const unchanged = await mutate(cwd, ["--json", "count.ts", "other.ts"]);
  expect(unchanged.code, unchanged.stderr).toBe(0);
  expect(unchanged.stdout).toContain('"status":"reused"');
  const snapshot = `${cwd}/__snapshots__/count.test.ts.snap`;
  await Bun.write(snapshot, (await Bun.file(snapshot).text()).replace("= `1`", "= `2`"));
  expect(ordinary().exitCode).toBe(1);
  const changed = await mutate(cwd, ["--json", "--keep-going", "count.ts", "other.ts"]);
  expect(changed.code, changed.stderr).toBe(3);
  const final = z
    .object({ state: z.object({ units: z.array(z.object({ status: z.string() })) }) })
    .parse(JSON.parse(changed.stdout.trim().split("\n").at(-1) ?? ""));
  expect(final.state.units.map((unit) => unit.status)).toEqual(["interrupted", "reused"]);
});

test("no target refuses without running tests or writing files", async () => {
  const cwd = await mkdtemp(`${root}/empty-`);
  const result = await mutate(cwd, []);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Usage: bun run mutate");
  expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd, dot: true }))).toEqual([]);
});

test("the repository's public script invokes the mutation CLI", async () => {
  const child = Bun.spawn([process.execPath, "run", "mutate", "--help"], {
    cwd: path.resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(code).toBe(0);
  expect(stdout).toStartWith("Usage: bun run mutate");
  expect(stdout).toContain("--recover-claim");
});

test("public planning launches no tests, preflight records only a baseline, and a budget refuses further execution", async () => {
  const receipt = `${root}/${crypto.randomUUID()}-planning`;
  const cwd = await fixture({
    "count.ts": "export function count(n: number) { return n + 1; }\n",
    "count.test.ts": `import {expect, test} from "bun:test";
import {appendFileSync} from "node:fs";
import {count} from "./count.ts";
test("count", () => {
  appendFileSync(${JSON.stringify(receipt)}, "run\\n");
  expect(count(1)).toBe(2);
});`,
  });
  const plan = await mutate(cwd, ["--plan", "--json", "count.ts"]);
  expect(plan.code, plan.stderr).toBe(0);
  expect(
    z
      .object({
        type: z.literal("selection-plan"),
        selectedUnits: z.literal(1),
        selectedTestFiles: z.literal(1),
      })
      .safeParse(JSON.parse(plan.stdout)).success,
  ).toBe(true);
  expect(await Bun.file(receipt).exists()).toBe(false);
  const bounded = await mutate(cwd, ["--budget", "0.000001", "count.ts"]);
  expect(bounded.code, bounded.stderr).toBe(3);
  expect(bounded.stderr).toContain("budget-exhausted");
  expect(await Bun.file(receipt).exists()).toBe(false);
  const measured = await mutate(cwd, ["--preflight", "--json", "count.ts"]);
  expect(measured.code, measured.stderr).toBe(3);
  expect(await Bun.file(receipt).text()).toBe("run\n");
  expect(
    z
      .object({
        mode: z.literal("preflight"),
        state: z.object({
          status: z.literal("incomplete"),
          completedUnits: z.literal(0),
          units: z.array(
            z.object({
              status: z.literal("unrun"),
              mutants: z.null(),
              preflight: z.object({
                baselineMs: z.number().nonnegative(),
                mutationCount: z.null(),
              }),
            }),
          ),
        }),
      })
      .safeParse(JSON.parse(measured.stdout.trim().split("\n").at(-1) ?? "")).success,
  ).toBe(true);
  expect(
    await Array.fromAsync(new Bun.Glob(".mutation-incremental/*").scan({ cwd, dot: true })),
  ).toEqual([]);
  expect(await Array.fromAsync(new Bun.Glob(".mutation-reuse/*").scan({ cwd, dot: true }))).toEqual(
    [],
  );
  const preflightRun = z
    .object({ runId: z.string() })
    .parse(JSON.parse(measured.stdout.trim().split("\n").at(-1) ?? ""));
  const resumePreflight = await mutate(cwd, ["--resume", preflightRun.runId]);
  expect(resumePreflight.code, resumePreflight.stderr).toBe(1);
  expect(resumePreflight.stderr).toContain(
    "Preflight evidence cannot resume mutation qualification.",
  );
  expect(await Bun.file(receipt).text()).toBe("run\n");
  const qualified = await mutate(cwd, ["count.ts"]);
  expect(qualified.code, qualified.stderr).toBe(0);
  expect(await Bun.file(receipt).text()).toBe("run\n".repeat(4));
});

test("public claim recovery preserves evidence and refuses active or uncertain owners", async () => {
  const cwd = await fixture({ "count.ts": "export const count = 1;\n" });
  const state = await mutationStateDirectory(cwd);
  await Bun.write(`${state}/claim/owner.json`, "uncertain");
  const uncertain = await mutate(cwd, ["--recover-claim"]);
  expect(uncertain.code).toBe(3);
  expect(uncertain.stderr).toContain("active or uncertain");
  expect(await Bun.file(`${state}/claim/owner.json`).text()).toBe("uncertain");
  const extra = await mutate(cwd, ["--recover-claim", "count.ts"]);
  expect(extra.code).toBe(1);
  expect(extra.stderr).toContain("Unknown option: --recover-claim");
  expect(await Bun.file(`${state}/claim/owner.json`).text()).toBe("uncertain");
  const token = crypto.randomUUID();
  await Bun.write(
    `${state}/claim/owner.json`,
    JSON.stringify({ version: 1, token, pid: process.pid }),
  );
  expect((await mutate(cwd, ["--recover-claim"])).code).toBe(3);
  const dead = Bun.spawn([process.execPath, "--version"], { stdout: "ignore" });
  await dead.exited;
  await Bun.write(
    `${state}/claim/owner.json`,
    JSON.stringify({ version: 1, token, pid: dead.pid }),
  );
  await Bun.write(`${state}/completed.json`, '{"status":"completed"}');
  const recovered = await mutate(cwd, ["--recover-claim"]);
  expect(recovered.code, recovered.stderr).toBe(0);
  expect(recovered.stdout).toBe(
    "Recovered interrupted mutation claim. Historical evidence was preserved.\n",
  );
  expect(await Bun.file(`${state}/completed.json`).text()).toBe('{"status":"completed"}');
  expect(await Bun.file(`${state}/recovered-${token}/owner.json`).exists()).toBe(true);
  expect(await Bun.file(`${state}/claim/owner.json`).exists()).toBe(false);
});

test("unsupported snapshot inputs report incomplete execution without starting tests", async () => {
  const receipt = `${root}/${crypto.randomUUID()}-forbidden`;
  const cwd = await fixture({
    "count.ts": "export const count = 1;\n",
    "count.test.ts": `await Bun.write(${JSON.stringify(receipt)}, "forbidden");`,
  });
  const outside = `${root}/${crypto.randomUUID()}-outside-source`;
  await Bun.write(outside, "unadmitted source\n");
  await symlink(outside, `${cwd}/external-link`);
  const result = await mutate(cwd, ["count.ts"]);
  expect(result.code).toBe(3);
  expect(result.stdout).toBe(
    "Mutation summary: incomplete. See docs/agents/testing/mutation-testing.md.\n",
  );
  expect(result.stderr).toContain("Mutation execution incomplete:");
  expect(result.stderr).toContain("Unsupported snapshot input: external-link");
  expect(await Bun.file(receipt).exists()).toBe(false);
});

test("a new snapshot invalidates historical engine results after imported or fixture source edits", async () => {
  const receipt = `${root}/${crypto.randomUUID()}-snapshot-executions`;
  const cwd = await fixture({
    "count.ts": "export function count(n: number) { return n + 1; }\n",
    "helper.ts": 'export const label = "first";\n',
    "data.txt": "first",
    "count.test.ts": `import { expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { count } from "./count.ts";
import { label } from "./helper.ts";
test("actual snapshot execution", async () => {
  appendFileSync(${JSON.stringify(receipt)}, "executed\\n");
  expect(["first", "second"]).toContain(label);
  expect(["first", "second"]).toContain(await Bun.file("data.txt").text());
  expect(count(1)).toBe(2);
});`,
  });
  const first = await mutate(cwd, ["count.ts"]);
  expect(first.code, first.stdout + first.stderr).toBe(0);
  expect(await Bun.file(receipt).text()).toBe("executed\n".repeat(3));
  await Bun.write(`${cwd}/helper.ts`, 'export const label = "second";\n');
  const imported = await mutate(cwd, ["count.ts"]);
  expect(imported.code, imported.stdout + imported.stderr).toBe(0);
  expect(await Bun.file(receipt).text()).toBe("executed\n".repeat(6));
  await Bun.write(`${cwd}/data.txt`, "second");
  const fixtureEdit = await mutate(cwd, ["count.ts"]);
  expect(fixtureEdit.code, fixtureEdit.stdout + fixtureEdit.stderr).toBe(0);
  expect(await Bun.file(receipt).text()).toBe("executed\n".repeat(9));
});

test("dependency edits rerun affected units without executing unchanged units", async () => {
  const firstReceipt = `${root}/${crypto.randomUUID()}-affected`;
  const otherReceipt = `${root}/${crypto.randomUUID()}-unaffected`;
  const cwd = await fixture({
    "helper.ts": "export const offset = 1;\n",
    "data.txt": "first",
    "count.ts":
      'import { offset } from "./helper.ts"; export function count(n: number) { return n + offset; }\n',
    "other.ts": "export function other(n: number) { return n + 1; }\n",
    "count.test.ts": `import { expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { count } from "./count.ts";
test("count", async () => { appendFileSync(${JSON.stringify(firstReceipt)}, "run\\n"); expect(["first", "second"]).toContain(await Bun.file("data.txt").text()); expect(count(1)).toBe(2); });`,
    "other.test.ts": `import { expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { other } from "./other.ts";
test("other", () => { appendFileSync(${JSON.stringify(otherReceipt)}, "run\\n"); expect(other(1)).toBe(2); });`,
  });
  const first = await mutate(cwd, ["count.ts", "other.ts"]);
  expect(first.code, first.stdout + first.stderr).toBe(0);
  const affected = await Bun.file(firstReceipt).text();
  const unaffected = await Bun.file(otherReceipt).text();
  expect(affected).toBe("run\n".repeat(3));
  expect(unaffected).toBe("run\n".repeat(3));
  const unchanged = await mutate(cwd, ["count.ts", "other.ts", "--json"]);
  expect(unchanged.code, unchanged.stdout + unchanged.stderr).toBe(0);
  expect(await Bun.file(firstReceipt).text()).toBe(affected);
  expect(await Bun.file(otherReceipt).text()).toBe(unaffected);
  expect(unchanged.stderr).toContain("count.ts (reused)");
  await Bun.write(`${cwd}/helper.ts`, "export const offset = 1; // changed dependency\n");
  const changed = await mutate(cwd, ["count.ts", "other.ts", "--json"]);
  expect(changed.code, changed.stdout + changed.stderr).toBe(0);
  expect(await Bun.file(firstReceipt).text()).toBe(affected.repeat(2));
  expect(await Bun.file(otherReceipt).text()).toBe(unaffected);
  expect(changed.stderr).toContain("other.ts (reused)");
  await Bun.write(`${cwd}/data.txt`, "second");
  const fixtureChanged = await mutate(cwd, ["count.ts", "other.ts", "--json"]);
  expect(fixtureChanged.code, fixtureChanged.stdout + fixtureChanged.stderr).toBe(0);
  expect(await Bun.file(firstReceipt).text()).toBe(affected.repeat(3));
  expect(await Bun.file(otherReceipt).text()).toBe(unaffected);
  await Bun.write(`${cwd}/bunfig.toml`, "[test]\ntimeout = 5001\n");
  const configurationChanged = await mutate(cwd, ["count.ts", "other.ts", "--json"]);
  expect(configurationChanged.code, configurationChanged.stdout + configurationChanged.stderr).toBe(
    0,
  );
  expect(await Bun.file(firstReceipt).text()).toBe(affected.repeat(4));
  expect(await Bun.file(otherReceipt).text()).toBe(unaffected.repeat(2));
});

test("a disposable candidate plans, fails fast, repairs and resumes without trusting stale qualification", async () => {
  const firstReceipt = `${root}/${crypto.randomUUID()}-completed`;
  const secondReceipt = `${root}/${crypto.randomUUID()}-unfinished`;
  const cwd = await fixture({
    "first.ts": "export function first(n: number) { return n + 1; }\n",
    "second.ts": "export function second(n: number) { return n + 1; }\n",
    "first.test.ts": `import { expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { first } from "./first.ts";
test("first", () => { appendFileSync(${JSON.stringify(firstReceipt)}, "run\\n"); expect(first(1)).toBe(2); });`,
    "second.test.ts": `import { expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { second } from "./second.ts";
test("second", () => { appendFileSync(${JSON.stringify(secondReceipt)}, "run\\n"); expect(second(1)).toBe(99); });`,
  });
  git(cwd, "init", "-q");
  git(cwd, "add", "first.ts", "first.test.ts", "second.ts", "second.test.ts", "package.json");
  git(cwd, "commit", "-qm", "candidate with an unfinished assertion");
  const planned = await mutate(cwd, ["--plan", "--json", "first.ts", "second.ts"]);
  expect(planned.code, planned.stderr).toBe(0);
  expect(JSON.parse(planned.stdout)).toMatchObject({
    type: "selection-plan",
    selectedUnits: 2,
    selectedTestFiles: 2,
  });
  expect(await Bun.file(firstReceipt).exists()).toBe(false);
  expect(await Bun.file(secondReceipt).exists()).toBe(false);
  const initial = await mutate(cwd, ["first.ts", "second.ts", "--json"]);
  expect(initial.code, initial.stdout + initial.stderr).toBe(3);
  const run = z
    .object({ runId: z.string() })
    .parse(JSON.parse(initial.stdout.split("\n")[0] ?? ""));
  const completed = await Bun.file(firstReceipt).text();
  expect(completed).toBe("run\n".repeat(3));
  expect(await Bun.file(secondReceipt).text()).toBe("run\n");
  const unchanged = await mutate(cwd, ["--resume", run.runId, "--json"]);
  expect(unchanged.code, unchanged.stdout + unchanged.stderr).toBe(3);
  expect(await Bun.file(firstReceipt).text()).toBe(completed);
  expect(await Bun.file(secondReceipt).text()).toBe("run\n".repeat(2));
  const testFile = Bun.file(`${cwd}/second.test.ts`);
  await Bun.write(testFile, (await testFile.text()).replace("toBe(99)", "toBe(2)"));
  const resumed = await mutate(cwd, ["--resume", run.runId, "--json"]);
  expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
  expect(await Bun.file(firstReceipt).text()).toBe(completed);
  expect(await Bun.file(secondReceipt).text()).toBe("run\n".repeat(5));
  expect(resumed.stderr).toContain("first.ts (reused)");
  expect(resumed.stderr).toContain("second.ts (passed)");
  const terminal = z.object({
    runId: z.string(),
    admission: z.object({ identity: z.string(), current: z.boolean() }),
    state: z.object({ status: z.string() }),
  });
  const qualified = terminal.parse(JSON.parse(resumed.stdout.trim().split("\n").at(-1) ?? ""));
  expect(qualified.state.status).toBe("passed");
  expect(qualified.admission.current).toBe(true);
  expect(await Bun.file(`${cwd}/.mutation-runs/${qualified.runId}.json`).json()).toMatchObject(
    qualified,
  );
  git(cwd, "add", "second.test.ts");
  git(cwd, "commit", "-qm", "repaired candidate");
  await Bun.write(`${cwd}/second.ts`, "export function second(n: number) { return n + 2; }\n");
  const stale = await mutate(cwd, ["--resume", qualified.runId, "--json"]);
  expect(stale.code, stale.stdout + stale.stderr).toBe(3);
  expect(await Bun.file(firstReceipt).text()).toBe(completed);
  expect(await Bun.file(secondReceipt).text()).toBe("run\n".repeat(6));
  const rejected = terminal.parse(JSON.parse(stale.stdout.trim().split("\n").at(-1) ?? ""));
  expect(rejected.admission.identity).not.toBe(qualified.admission.identity);
  expect(rejected.state.status).toBe("incomplete");
  expect(rejected.admission.current).toBe(true);
  // The historical receipt remains true only for its old candidate.
  expect(await Bun.file(`${cwd}/.mutation-runs/${qualified.runId}.json`).json()).toMatchObject(
    qualified,
  );
  await Bun.write(`${cwd}/second.ts`, "export function second(n: number) { return n + 1; }\n");
  const final = await mutate(cwd, ["--resume", rejected.runId, "--json"]);
  expect(final.code, final.stdout + final.stderr).toBe(0);
  expect(await Bun.file(firstReceipt).text()).toBe(completed);
  const exact = terminal.parse(JSON.parse(final.stdout.trim().split("\n").at(-1) ?? ""));
  expect(exact.admission).toEqual(qualified.admission);
  expect(exact.state.status).toBe("passed");
});

test("dynamic inputs execute again and partial completed receipts cannot pass by reuse", async () => {
  const receipt = `${root}/${crypto.randomUUID()}-dynamic`;
  const cwd = await fixture({
    "count.ts": "export function count(n: number) { return n + 1; }\n",
    "helper.ts": "export const value = 1;\n",
    "count.test.ts": `import { expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { count } from "./count.ts";
test("count", async () => {
  appendFileSync(${JSON.stringify(receipt)}, "run\\n");
  const { value } = await import("./helper.ts");
  expect(count(value)).toBe(2);
});`,
  });
  for (const expected of [3, 6]) {
    const result = await mutate(cwd, ["count.ts"]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(await Bun.file(receipt).text()).toBe("run\n".repeat(expected));
  }
  const file = Bun.file(`${cwd}/count.test.ts`);
  await Bun.write(file, (await file.text()).replace('await import("./helper.ts")', "{ value: 1 }"));
  expect((await mutate(cwd, ["count.ts"])).code).toBe(0);
  const records = await Array.fromAsync(new Bun.Glob("*.json").scan(`${cwd}/.mutation-reuse`));
  expect(records).toHaveLength(1);
  await Bun.write(`${cwd}/.mutation-reuse/${records[0]}`, '{"version":1,"results":[]}');
  const rerun = await mutate(cwd, ["count.ts"]);
  expect(rerun.code, rerun.stdout + rerun.stderr).toBe(0);
  expect(await Bun.file(receipt).text()).toBe("run\n".repeat(12));
});

test("sandbox tests can execute the source CLI that Stryker copies without its executable mode", async () => {
  const cwd = await fixture({
    "src/cli.ts": `#!${process.execPath}\nconsole.log("fixture release");\n`,
    "src/lib/count.ts": "export function count(n: number) { return n + 1; }\n",
    "src/lib/count.test.ts": `import { expect, test } from "bun:test";
import { count } from "./count.ts";
test("source command identity", () => {
  const command = Bun.spawnSync(["./src/cli.ts"], { stdout: "pipe", stderr: "pipe" });
  expect(command.exitCode).toBe(0);
  expect(command.stdout.toString()).toBe("fixture release\\n");
  expect(count(1)).toBe(2);
});\n`,
  });
  await chmod(`${cwd}/src/cli.ts`, 0o755);
  const result = await mutate(cwd, ["src/lib/count.ts"]);
  expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
  expect(result.stdout).toContain("0 survivors, 0 untested, 0 incomplete");
});

test("valid local suppressions are ignored, not reported as killed", async () => {
  const cwd = await fixture({
    "src/lib/count.ts":
      "// Stryker disable next-line ArithmeticOperator: no rule: this fixture only promises a numeric result\nexport function count(n: number) { return n + 1; }\n",
    "src/lib/count.test.ts":
      'import { test, expect } from "bun:test"; import { count } from "./count.ts"; test("numeric", () => { expect(typeof count(2)).toBe("number"); });\n',
  });
  const result = await mutate(cwd, ["src/lib/count.ts"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(", 1 killed, 1 ignored");
  const ignored = z
    .object({
      unit: z.literal("src/lib/count.ts"),
      id: z.string().min(1),
      status: z.literal("Ignored"),
      mutatorName: z.literal("ArithmeticOperator"),
      replacement: z.literal("n - 1"),
      original: z.literal("n + 1"),
      location: z.object({
        start: z.object({ line: z.literal(2), column: z.number() }),
        end: z.object({ line: z.literal(2), column: z.number() }),
      }),
    })
    .parse(JSON.parse(result.stdout.split("\n").find((line) => line.startsWith("{")) ?? "null"));
  expect(ignored.location.start.column).toBeLessThan(ignored.location.end.column);
});

test("a mutant's first test failure stops before the next test's effects", async () => {
  const cwd = await fixture({
    "count.ts": "export function count(n: number) { return n + 1; }\n",
  });
  const receipt = path.join(root, `${crypto.randomUUID()}-second-test-receipt.txt`);
  await Bun.write(receipt, "");
  await Bun.write(
    path.join(cwd, "count.test.ts"),
    `import { expect, test } from "bun:test";
import { count } from "./count.ts";
test("the count is correct", () => expect(count(1)).toBe(2));
test("the next test records its effect", async () => {
  const receipt = ${JSON.stringify(receipt)};
  await Bun.write(receipt, (await Bun.file(receipt).text()) + "reached\\n");
});
`,
  );
  const result = await mutate(cwd, ["count.ts"]);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("0 survivors, 0 untested, 0 incomplete");
  expect(await Bun.file(receipt).text()).toBe("reached\n");
});

test("a failing unit forbids the later unit's real effects unless keep-going is explicit", async () => {
  const receipt = path.join(root, crypto.randomUUID());
  const cwd = await fixture({
    "first.ts": "export const count = (n: number) => n + 1;\n",
    "first.test.ts":
      'import { expect, test } from "bun:test"; import { count } from "./first.ts"; test("weak", () => expect(typeof count(1)).toBe("number"));\n',
    "later.ts": "export const count = (n: number) => n + 1;\n",
    "later.test.ts": `import { expect, test } from "bun:test"; import { count } from "./later.ts";
test("expensive later unit", async () => { await Bun.write(${JSON.stringify(receipt)}, "executed"); await Bun.sleep(100); expect(count(1)).toBe(2); });\n`,
  });
  const first = await mutate(cwd, ["first.ts", "later.ts"]);
  expect(first.code, first.stdout + first.stderr).toBe(2);
  expect(await Bun.file(receipt).exists()).toBe(false);
  expect(first.stderr).toContain("1/2 completed");
  expect(first.stderr).toContain("1 unrun");
  const files = await Array.fromAsync(
    new Bun.Glob(".mutation-runs/*.json").scan({ cwd, dot: true }),
  );
  expect(files).toHaveLength(1);
  const stored = z
    .object({
      version: z.literal(1),
      state: z.object({
        status: z.literal("failed"),
        units: z.array(z.object({ status: z.string(), mutants: z.array(z.unknown()).nullable() })),
      }),
    })
    .parse(await Bun.file(path.join(cwd, String(files[0]))).json());
  expect(stored.state.units.map((unit) => unit.status)).toEqual(["failed", "unrun"]);
  expect(stored.state.units[0]?.mutants?.length).toBeGreaterThan(0);
  expect(stored.state.units[1]?.mutants).toBeNull();
  const continued = await mutate(cwd, ["--keep-going", "first.ts", "later.ts"]);
  expect(continued.code, continued.stdout + continued.stderr).toBe(2);
  expect(await Bun.file(receipt).text()).toBe("executed");
  expect(continued.stderr).toContain("2/2 completed");
});

test("machine and human progress are live while a controlled real unit is active", async () => {
  const release = path.join(root, crypto.randomUUID());
  const ready = path.join(root, crypto.randomUUID());
  const cwd = await fixture({
    "count.ts": "export const count = (n: number) => n + 1;\n",
    "count.test.ts": `import { expect, test } from "bun:test"; import { count } from "./count.ts";
test("controlled baseline", async () => {
  await Bun.write(${JSON.stringify(ready)}, "ready");
  while (!(await Bun.file(${JSON.stringify(release)}).exists())) await Bun.sleep(20);
  expect(count(1)).toBe(2);
}, 20000);\n`,
  });
  const child = Bun.spawn([process.execPath, script, "--json", "count.ts"], {
    cwd,
    env: Environment.child({
      HOME: root,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const events: unknown[] = [];
  let buffer = "";
  let released = false;
  try {
    for await (const chunk of child.stdout) {
      buffer += new TextDecoder().decode(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const raw: unknown = JSON.parse(line);
        const event = z
          .object({
            version: z.literal(1),
            runId: z.string(),
            type: z.string(),
            elapsedMs: z.number(),
            state: z.object({
              activeUnit: z.string().nullable(),
              completedUnits: z.number(),
              units: z.array(
                z.object({
                  status: z.string(),
                  mutants: z.array(z.unknown()).nullable(),
                  progress: z.object({ completed: z.number(), total: z.number().nullable() }),
                }),
              ),
            }),
          })
          .parse(raw);
        events.push(raw);
        if (event.type === "progress" && !released && (await Bun.file(ready).exists())) {
          expect(child.exitCode).toBeNull();
          expect(event.state.activeUnit).toBe("count.ts");
          expect(event.state.completedUnits).toBe(0);
          expect(event.state.units[0]).toMatchObject({
            status: "running",
            mutants: null,
            progress: { completed: 0, total: null },
          });
          expect(event.elapsedMs).toBeGreaterThanOrEqual(1000);
          const stored: unknown = await Bun.file(
            `${cwd}/.mutation-runs/${event.runId}.json`,
          ).json();
          expect(stored).toEqual(raw);
          await Bun.write(release, "released");
          released = true;
        }
      }
    }
    expect(await child.exited).toBe(0);
    expect(await Bun.file(release).exists()).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "run-completed",
      state: {
        activeUnit: null,
        completedUnits: 1,
        units: [{ status: "passed", progress: { completed: 2, total: 2 } }],
      },
    });
    const human = await stderr;
    expect(human).toContain("progress, running, 0/1 completed, active count.ts");
    expect(human).toContain("run-completed, passed, 1/1 completed, active none");
  } finally {
    await Bun.write(release, "cleanup");
    await child.exited;
  }
});

test("completed command evidence survives a later engine interruption and JSON stays parseable", async () => {
  const forbidden = path.join(root, crypto.randomUUID());
  const cwd = await fixture({
    "first.ts": "export const count = (n: number) => n + 1;\n",
    "first.test.ts":
      'import { expect, test } from "bun:test"; import { count } from "./first.ts"; test("exact", () => expect(count(1)).toBe(2));\n',
    "broken.ts": "export const count = (n: number) => n + 1;\n",
    "broken.test.ts":
      'import { expect, test } from "bun:test"; import { count } from "./broken.ts"; test("broken", () => expect(count(1)).toBe(99));\n',
    "last.ts": "export const count = (n: number) => n + 1;\n",
    "last.test.ts": `import { test } from "bun:test"; test("forbidden", async () => { await Bun.write(${JSON.stringify(forbidden)}, "executed"); });\n`,
  });
  const result = await mutate(cwd, ["--json", "first.ts", "broken.ts", "last.ts"]);
  expect(result.code, result.stderr).toBe(3);
  expect(result.stderr).toContain("Mutation execution incomplete");
  expect(result.stderr).toContain("Mutation summary: incomplete.");
  const eventSchema = z.looseObject({ runId: z.string(), type: z.string() });
  const events = result.stdout
    .trim()
    .split("\n")
    .map((line) => eventSchema.parse(JSON.parse(line)));
  expect(events.at(-1)).toMatchObject({
    version: 1,
    type: "run-completed",
    state: {
      status: "incomplete",
      completedUnits: 1,
      activeUnit: null,
      units: [
        { status: "passed", progress: { completed: 2 } },
        { status: "interrupted", mutants: null },
        { status: "unrun", mutants: null },
      ],
    },
  });
  const id = z.object({ runId: z.string() }).parse(events[0]).runId;
  expect(await Bun.file(`${cwd}/.mutation-runs/${id}.json`).json()).toEqual(events.at(-1));
  expect(await Bun.file(forbidden).exists()).toBe(false);
  const reused = await mutate(cwd, ["--json", "first.ts"]);
  expect(reused.code, reused.stderr).toBe(0);
  expect(reused.stderr).toContain(
    "Mutation summary: 0 survivors, 0 untested, 0 incomplete, 2 killed",
  );
  const last: unknown = JSON.parse(reused.stdout.trim().split("\n").at(-1) ?? "null");
  expect(last).toMatchObject({
    state: {
      units: [{ status: "reused", progress: { completed: 2, total: 2, reused: 2 } }],
    },
  });
  expect(reused.stderr).toContain("2 reused");
});

test.each([0o700, 0o755])(
  "sandbox tests preserve the actual source readiness command in a private copy with mode %i",
  async (mode) => {
    const cwd = await fixture({});
    const repository = path.resolve(import.meta.dir, "..");
    await rm(path.join(cwd, "node_modules"), { recursive: true });
    await symlink(
      path.dirname(path.dirname(Bun.resolveSync("zod/package.json", import.meta.dir))),
      path.join(cwd, "node_modules"),
    );
    const original = path.join(repository, "src/cli.ts");
    const copied = path.join(cwd, "src/cli.ts");
    const receipt = path.join(root, `${crypto.randomUUID()}-source-command-receipt.json`);
    await cp(path.join(repository, "src"), path.join(cwd, "src"), { recursive: true });
    await cp(path.join(repository, "skills"), path.join(cwd, "skills"), { recursive: true });
    await Bun.write(
      path.join(cwd, "tools/device-fixture.ts"),
      Bun.file(path.join(repository, "tools/device-fixture.ts")),
    );
    const packaged = z
      .looseObject({})
      .parse(await Bun.file(path.join(repository, "package.json")).json());
    await Bun.write(
      path.join(cwd, "package.json"),
      JSON.stringify({
        ...packaged,
        scripts: { test: "bun test --isolate" },
      }),
    );
    const before = await lstat(copied);
    const source = await lstat(original);
    expect(before.isSymbolicLink()).toBe(false);
    expect(await realpath(copied)).toBe(copied);
    // Git checkouts can restrict executable permissions through the creating process's umask.
    expect(before.mode % 0o1000).toBe(source.mode % 0o1000);
    expect((await lstat(root)).mode % 0o1000).toBe(0o700);
    expect(before.nlink).toBe(1);
    expect([before.dev, before.ino]).not.toEqual([source.dev, source.ino]);
    const sourceText = await Bun.file(original).text();
    // Stryker inserts this type-check directive without changing the source command's behavior.
    const identity = new Bun.CryptoHasher("sha256")
      .update(sourceText.replace("// @ts-nocheck\n", ""))
      .digest("hex");
    expect(await Bun.file(copied).text()).toBe(sourceText);
    await chmod(copied, mode);
    // Exercise the real outer annotation before the nested Stryker run copies this command again.
    const { disableTypeChecks } = await import("@stryker-mutator/instrumenter");
    const shebang = "#!/usr/bin/env bun\n";
    const annotatedShebang = `${shebang}// @ts-nocheck\n`;
    const canonicalSource = sourceText.startsWith(annotatedShebang)
      ? shebang + sourceText.slice(annotatedShebang.length)
      : sourceText;
    const annotated = await disableTypeChecks(
      { name: copied, content: canonicalSource, mutate: false },
      { plugins: null },
    );
    expect(annotated.content).toBe(annotatedShebang + canonicalSource.slice(shebang.length));
    const nested = await disableTypeChecks(annotated, { plugins: null });
    expect(nested.content.replace("// @ts-nocheck\n", "")).toBe(
      shebang + "// \n" + canonicalSource.slice(shebang.length),
    );
    const restored = shebang + annotated.content.slice(annotatedShebang.length);
    expect(restored).toBe(canonicalSource);
    expect(new Bun.CryptoHasher("sha256").update(restored).digest("hex")).toBe(identity);
    console.error(
      JSON.stringify({
        phase: "outer-annotation-normalization",
        annotatedHash: new Bun.CryptoHasher("sha256").update(annotated.content).digest("hex"),
        nestedHash: new Bun.CryptoHasher("sha256").update(nested.content).digest("hex"),
        restoredHash: identity,
        removed: "// @ts-nocheck\n",
      }),
    );
    await Bun.write(copied, restored);
    console.error(
      JSON.stringify({
        phase: "original-private-copy",
        copied,
        mode: before.mode % 0o1000,
        links: before.nlink,
        dev: before.dev,
        ino: before.ino,
        identity,
      }),
    );
    await Bun.write(
      path.join(cwd, "src/lib/source-readiness-count.ts"),
      "export function count(n: number) { return n + 1; }\n",
    );
    await Bun.write(
      path.join(cwd, "src/lib/source-readiness-count.test.ts"),
      `import { expect, test } from "bun:test";
// Bun has no permission, file metadata, symlink, or temporary-directory API.
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Environment } from "../modules/environment/main.ts";
import { writeGuideSkills, writeOpenCodePlugin } from "../modules/operator-cli/command-fixture.ts";
import { registerTestDevice } from "../../tools/device-fixture.ts";
import { count } from "./source-readiness-count.ts";
test("the actual source command passes readiness through its PATH link", async () => {
  const cli = Bun.fileURLToPath(new URL("../cli.ts", import.meta.url));
  const project = path.resolve(import.meta.dir, "../..");
  const expected = ${JSON.stringify({ cwd, copied, receipt, dev: before.dev, ino: before.ino, identity })};
   expect(project === expected.cwd || (project.includes("/.mutation-") && path.basename(project).startsWith("sandbox-") && project.includes("/sandbox/"))).toBe(true);
  const metadata = await lstat(cli);
  expect(metadata.isFile()).toBe(true);
  expect(metadata.isSymbolicLink()).toBe(false);
  expect(await realpath(cli)).toBe(cli);
  expect(metadata.nlink).toBe(1);
  if (cli !== expected.copied) expect([metadata.dev, metadata.ino]).not.toEqual([expected.dev, expected.ino]);
  const sourceText = (await Bun.file(cli).text()).replace("// @ts-nocheck\\n", "");
  expect(new Bun.CryptoHasher("sha256").update(sourceText).digest("hex")).toBe(expected.identity);
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-source-mode-")));
  try {
    const database = await registerTestDevice(root);
    await Bun.write(root + "/config/operator/config.json", JSON.stringify({ superAgent: { host: "opencode" } }), { createPath: true });
    await mkdir(root + "/config/opencode", { recursive: true });
    await symlink(project + "/skills", root + "/config/opencode/skills");
    await writeGuideSkills(root + "/home/.agents/skills", root + "/config/opencode/skills");
    await Bun.write(root + "/home/.agents/skills/code-review/SKILL.md", "# Test upstream review\\n", { createPath: true });
    await writeOpenCodePlugin(root + "/config");
    await mkdir(root + "/tools", { recursive: true });
    await symlink(cli, root + "/tools/operator");
    await symlink(process.execPath, root + "/tools/bun");
    for (const tool of ["gh", "herdr", "opencode"]) {
      const file = root + "/tools/" + tool;
      await Bun.write(file, "#!" + process.execPath + "\\nprocess.exit(" + (tool === "gh" ? "0" : "99") + ");\\n");
      await chmod(file, 0o755);
    }
    const foreign = root + "/foreign/operator";
    await Bun.write(foreign, "#!" + process.execPath + "\\nprocess.exit(99);\\n", { createPath: true });
    await chmod(foreign, 0o755);
    const PATH = root + "/tools:" + root + "/foreign";
    const selected = Bun.which("operator", { PATH });
    const observed = { phase: "actual-readiness", cli, project, mode: metadata.mode & 0o777, links: metadata.nlink, dev: metadata.dev, ino: metadata.ino, selected, selectedRealpath: selected === null ? null : await realpath(selected), PATH, root, sourceIdentity: new Bun.CryptoHasher("sha256").update(sourceText).digest("hex") };
    console.error(JSON.stringify(observed));
    const child = Bun.spawn([process.execPath, cli, "ready", "--json"], {
      cwd: project,
      env: Environment.child({ HOME: root + "/home", XDG_CONFIG_HOME: root + "/config", XDG_STATE_HOME: root + "/state", PATH, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    console.error(stdout);
    expect(code, stdout + stderr).toBe(0);
    expect(await realpath(String(selected))).toBe(cli);
    expect(JSON.parse(stdout)).toMatchObject({ reason: "ready", blockers: [] });
    expect(await Bun.file(root + "/state/operator/operator.sqlite").arrayBuffer()).toEqual(database);
    await Bun.write(expected.receipt, JSON.stringify({ ...observed, code, readiness: JSON.parse(stdout) }));
    expect(count(1)).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
`,
    );
    const baseline = Bun.spawn(
      [process.execPath, "test", "--isolate", "src/lib/source-readiness-count.test.ts"],
      {
        cwd,
        env: Environment.child({
          HOME: root,
          XDG_CONFIG_HOME: `${root}/config`,
          XDG_STATE_HOME: `${root}/state`,
        }),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [baselineCode, baselineOut, baselineError] = await Promise.all([
      baseline.exited,
      new Response(baseline.stdout).text(),
      new Response(baseline.stderr).text(),
    ]);
    console.error(baselineError);
    expect(baselineCode, baselineOut + baselineError).toBe(0);
    await rm(receipt);
    const result = await mutate(cwd, ["src/lib/source-readiness-count.ts"]);
    console.error(result.stderr);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("0 survivors, 0 untested, 0 incomplete");
    const observed = z
      .looseObject({
        project: z.string(),
        mode: z.number(),
        links: z.number(),
        selectedRealpath: z.string(),
        cli: z.string(),
        sourceIdentity: z.string(),
        readiness: z.unknown(),
      })
      .parse(await Bun.file(receipt).json());
    console.error(JSON.stringify({ phase: "retained-sandbox-receipt", ...observed }));
    expect(observed.project).not.toStartWith(cwd);
    expect(observed.project).toContain("/.mutation-");
    expect(path.basename(observed.project)).toStartWith("sandbox-");
    expect(observed.project).toContain("/sandbox/");
    expect(observed.mode).toBe(0o755);
    expect(observed.links).toBe(1);
    expect(observed.selectedRealpath).toBe(observed.cli);
    expect(observed.sourceIdentity).toBe(identity);
    expect(observed.readiness).toMatchObject({ reason: "ready", blockers: [] });
    expect((await lstat(original)).mode).toBe(source.mode);
    expect(await Bun.file(original).text()).toBe(sourceText);
  },
);

// Early in the file, so a broken reuse fails before the slow tests run.
test("a rerun reuses verdicts, and a changed test or an incomplete result runs again", async () => {
  const runs = path.join(root, crypto.randomUUID());
  const besideTest = `import { test, expect } from "bun:test";
import { appendFileSync } from "node:fs";
import { count, drain } from "./count.ts";
test("exact", () => {
  appendFileSync(${JSON.stringify(runs)}, (process.env.__STRYKER_ACTIVE_MUTANT__ ?? "dry run") + "\\n");
  expect(count(2)).toBe(3);
  expect(drain(2)).toBe(0);
});\n`;
  const cwd = await fixture({
    "src/lib/count.ts":
      "export function count(n: number) { return n + 1; }\nexport function drain(n: number) {\n  while (n > 0) n--;\n  return n;\n}\nexport const unchecked = (n: number) => n * 2;\n",
    "src/lib/count.test.ts": besideTest,
  });
  const stored = z.looseObject({
    files: z.record(
      z.string(),
      z.looseObject({ mutants: z.array(z.looseObject({ id: z.string(), status: z.string() })) }),
    ),
  });
  /**
   * The mutants that each run started. A busy machine can stop a mutant at its time limit before
   * its test logs it, so a started mutant either logged its id or has a Timeout status.
   */
  async function rerun() {
    await Bun.write(runs, "");
    const result = await mutate(cwd, ["src/lib/count.ts"]);
    // Each run stores its result in the newest file. A changed test starts a new file.
    const files = await Array.fromAsync(
      new Bun.Glob(".mutation-incremental/**/*.json").scan({ cwd, dot: true }),
    );
    expect(files).not.toEqual([]);
    const newest = files
      .map((file) => Bun.file(path.join(cwd, file)))
      .toSorted((a, b) => b.lastModified - a.lastModified)[0];
    const mutants = Object.values(stored.parse(await newest?.json()).files).flatMap(
      (file) => file.mutants,
    );
    const logged = (await Bun.file(runs).text()).split("\n").filter((line) => line !== "");
    const timedOut = mutants.filter(({ status }) => status === "Timeout").map(({ id }) => id);
    return {
      code: result.code,
      summary: result.stdout.trim().split("\n").at(-1),
      mutants,
      started: [...new Set([...logged, ...timedOut])].filter((id) => id !== "dry run").toSorted(),
    };
  }

  /** The killed and survived verdicts of a run, by mutant id. Only these are stored for reuse. */
  function verdicts(run: Awaited<ReturnType<typeof rerun>>) {
    return Object.fromEntries(
      run.mutants
        .filter(({ status }) => status === "Killed" || status === "Survived")
        .map(({ id, status }) => [id, status]),
    );
  }

  const first = await rerun();
  expect(first.code).toBe(3);
  // Only the mutants without a stored killed or survived verdict run again. The loop always times out.
  const unjudged = first.mutants
    .map(({ id }) => id)
    .filter((id) => verdicts(first)[id] === undefined);
  expect(unjudged).not.toEqual([]);
  const second = await rerun();
  expect(second.code).toBe(3);
  expect(second.started).toEqual(unjudged.toSorted());
  // A reused verdict keeps its status.
  expect(verdicts(second)).toMatchObject(verdicts(first));
  expect(second.summary).toMatch(
    / [1-9]\d* survivors, 0 untested, [1-9]\d* incomplete, [1-9]\d* killed, /,
  );
  // A changed beside-test reruns every mutant.
  await Bun.write(
    path.join(cwd, "src/lib/count.test.ts"),
    besideTest.replace('"exact"', '"renamed"'),
  );
  expect((await rerun()).started).toEqual(first.mutants.map(({ id }) => id).toSorted());
}, 120_000);

test("a weak beside-test reports actionable survivors in fresh Bun processes", async () => {
  const processes = path.join(root, crypto.randomUUID());
  const cwd = await fixture({
    "src/lib/count.ts": "export function count(n: number) { return n + 1; }\n",
    "src/lib/count.test.ts": `import { test, expect } from "bun:test";
import { appendFileSync } from "node:fs";
import { count } from "./count.ts";
test("weak", () => {
  appendFileSync(${JSON.stringify(processes)}, process.pid + "\\n");
  expect(typeof count(2)).toBe("number");
});\n`,
    "src/lib/other.test.ts":
      'import { test } from "bun:test"; test("not selected", () => { throw new Error("wrong test"); });\n',
  });
  const result = await mutate(cwd, ["src/lib/count.test.ts"]);
  expect(result.code).toBe(2);
  expect(result.stdout).toMatch(
    /lib\/count.ts:1: survived: ArithmeticOperator: `n \+ 1` to `n - 1`/,
  );
  expect(result.stdout).toContain("docs/agents/testing/mutation-testing.md");
  const pids = (await Bun.file(processes).text()).trim().split("\n");
  expect(pids.length).toBeGreaterThan(1);
  expect(new Set(pids).size).toBe(pids.length);
  expect(await Bun.file(path.join(cwd, "src/lib/count.ts")).text()).toBe(
    "export function count(n: number) { return n + 1; }\n",
  );
}, 30_000);

test("missing direct tests do not borrow a module interface test", async () => {
  const cwd = await fixture({
    "src/modules/sample/private.ts": "export const number = 1;\n",
    "src/modules/sample/main.test.ts":
      'import { test } from "bun:test"; test("interface", () => {});\n',
  });
  const result = await mutate(cwd, ["src/modules/sample/private.ts"]);
  expect(result.code).toBe(2);
  expect(result.stdout).toContain("src/modules/sample/private.ts: untested");
  expect(
    await Array.fromAsync(new Bun.Glob(".mutation-*").scan({ cwd, onlyFiles: false })),
  ).toEqual([".mutation-runs"]);
});

test("scenario paths select their unit and only that unit's beside-tests run", async () => {
  const cwd = await fixture({
    "tsconfig.json": "{}\n",
    "docs/agents/testing/mutation-testing.md": "local guidance\n",
    ".operator/untouched": "unfinished legacy work\n",
    "src/modules/sample/main.ts": "export function count(n: number) { return n + 1; }\n",
    "src/modules/sample/main.scenario.test.ts":
      'import { test, expect } from "bun:test"; import { existsSync } from "node:fs"; import { count } from "./main.ts"; test("exact", () => { expect(count(2)).toBe(3); expect(existsSync(".operator")).toBe(false); expect(existsSync(".agents/skills/host-skill")).toBe(false); expect(existsSync("docs/agents/testing/mutation-testing.md")).toBe(true); });\n',
    "src/modules/sample/unrelated.test.ts": "throw new Error('must not run');\n",
  });
  await mkdir(path.join(cwd, ".agents/skills"), { recursive: true });
  await symlink(root, path.join(cwd, ".agents/skills/host-skill"));
  const result = await mutate(cwd, ["src/modules/sample/main.scenario.test.ts"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("0 survivors");
});

test.each([
  "Stryker disable next-line ArithmeticOperator: too hard",
  "Stryker disable next-line ALL: no rule: blanket skip",
  "Stryker disable next-line StringLiteral, All: equivalent: blanket skip",
])("invalid suppression %s refuses all targets before tests run", async (suppression) => {
  const cwd = await fixture({
    "src/lib/good.ts": "export const value = 1;\n",
    "src/lib/good.test.ts": "throw new Error('must not run');\n",
    "src/lib/bad.ts": `// ${suppression}\nexport const value = 1 + 2;\n`,
  });
  const result = await mutate(cwd, ["src/lib/good.ts", "src/lib/bad.ts"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("src/lib/bad.ts:1");
  expect(result.stderr).toContain("equivalent:");
  expect(
    await Array.fromAsync(new Bun.Glob(".mutation-*").scan({ cwd, onlyFiles: false })),
  ).toEqual([]);
});

test("fixtures, generated code, and the top-of-file no-logic opt-out need no tests", async () => {
  const cwd = await fixture({
    "src/lib/data-fixture.ts": "throw new Error('fixture');\n",
    "src/lib/schema.generated.ts": "throw new Error('generated');\n",
    "src/lib/generated/schema.ts": "throw new Error('generated folder');\n",
    "src/lib/fixtures/data.ts": "throw new Error('fixture folder');\n",
    "src/lib/types.ts": "// Stryker disable all: no logic\nexport type Name = string;\n",
  });
  const result = await mutate(cwd, [
    "src/lib/data-fixture.ts",
    "src/lib/schema.generated.ts",
    "src/lib/generated/schema.ts",
    "src/lib/fixtures/data.ts",
    "src/lib/types.ts",
  ]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("5 skipped");
});

test("--since uses only changed lines against a real explicit Git ref", async () => {
  const unit = "src/lib/count [one]'s.ts";
  const cwd = await fixture({
    [unit]:
      "export function old(n: number) { return n - 1; }\nexport function count(n: number) { return n + 1; }\n",
    "src/lib/count [one]'s.test.ts": `import { test, expect } from "bun:test"; import { old, count } from "./count [one]'s.ts";
test("contracts", () => { expect(typeof old(3)).toBe("number"); expect(count(2)).toBe(4); });\n`,
    ".gitignore": "node_modules/\n.mutation-*/\n",
  });
  git(cwd, "init", "--quiet");
  git(cwd, "add", ".");
  git(cwd, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "baseline");
  const ref = git(cwd, "rev-parse", "HEAD");
  await Bun.write(
    path.join(cwd, unit),
    "export function old(n: number) { return n - 1; }\nexport function count(n: number) { return n + 2; }\n",
  );
  const changed = await mutate(cwd, ["--since", ref]);
  expect(changed.code).toBe(0);
  expect(changed.stdout).toContain("0 survivors");
  const whole = await mutate(cwd, [unit]);
  expect(whole.code).toBe(2);
  expect(whole.stdout).toContain(`${unit}:1: survived:`);
  expect(git(cwd, "diff", "--name-only")).toBe(unit);
});

test.each(
  [
    [],
    ["--since"],
    ["--since", "--bad"],
    ["--bad"],
    ["missing.ts"],
    ["../escape.ts"],
    [".operator/untouched.ts"],
    ["--help", "--help"],
  ].map((args) => ({ args })),
)("usage refusal %j has no effects", async ({ args }) => {
  const cwd = await fixture({ ".operator/untouched.ts": "do not read or change\n" });
  const result = await mutate(cwd, args);
  expect(result.code).toBe(1);
  expect(await Bun.file(path.join(cwd, ".operator/untouched.ts")).text()).toBe(
    "do not read or change\n",
  );
  expect(
    await Array.fromAsync(new Bun.Glob(".mutation-*").scan({ cwd, onlyFiles: false })),
  ).toEqual([]);
});

test("a failed initial test run is incomplete, never clean or a killed mutant", async () => {
  const cwd = await fixture({
    "src/lib/count.ts": "export function count(n: number) { return n + 1; }\n",
    "src/lib/count.test.ts":
      'import { test, expect } from "bun:test"; import { count } from "./count.ts"; test("broken baseline", () => { expect(count(2)).toBe(99); });\n',
  });
  const result = await mutate(cwd, ["src/lib/count.ts"]);
  expect(result.code).toBe(3);
  expect(result.stderr).toContain("Mutation execution incomplete");
  expect(result.stdout).toEndWith(
    "Mutation summary: incomplete. See docs/agents/testing/mutation-testing.md.\n",
  );
  expect(
    await Array.fromAsync(new Bun.Glob(".mutation-*").scan({ cwd, onlyFiles: false })),
  ).toEqual([".mutation-runs"]);
});

test("--since includes new untracked units, skips deletions, and refuses a bad ref", async () => {
  const cwd = await fixture({
    "src/lib/removed.ts": "export const n = 1;\n",
    ".gitignore": "node_modules/\n.mutation-*/\n",
  });
  git(cwd, "init", "--quiet");
  git(cwd, "add", ".");
  git(cwd, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "baseline");
  expect((await mutate(cwd, ["--since", "HEAD"])).code).toBe(0);
  await Bun.file(path.join(cwd, "src/lib/removed.ts")).delete();
  await Bun.write(path.join(cwd, "src/lib/new.ts"), "export const n = 2;\n");
  const result = await mutate(cwd, ["--since", "HEAD"]);
  expect(result.code).toBe(2);
  expect(result.stdout).toContain("src/lib/new.ts: untested");
  expect(result.stdout).not.toContain("src/lib/removed.ts");
  expect((await mutate(cwd, ["--since", "not-a-real-ref"])).code).toBe(1);
});

test("case-insensitive wildcard suppressions cannot hide survivors", async () => {
  const cwd = await fixture({
    "src/lib/count.ts":
      "// Stryker disable next-line ALL: no rule: blanket skip\nexport function count(n: number) { return n + 1; }\n",
    "src/lib/count.test.ts":
      'import { test, expect } from "bun:test"; import { count } from "./count.ts"; test("weak", () => { expect(typeof count(2)).toBe("number"); });\n',
  });
  expect((await mutate(cwd, ["src/lib/count.ts"])).code).toBe(1);
});

test("removing the summary's guidance topic makes its real check fail", async () => {
  const topic = "docs/agents/testing/mutation-testing.md";
  const cwd = await fixture({
    "tools/mutation-policy.guidance.test.ts": await Bun.file(
      path.join(import.meta.dir, "mutation-policy.guidance.test.ts"),
    ).text(),
    "tools/mutation-policy.ts": await Bun.file(
      path.join(import.meta.dir, "mutation-policy.ts"),
    ).text(),
    [topic]: await Bun.file(path.resolve(import.meta.dir, "..", topic)).text(),
  });
  await mkdir(`${cwd}/node_modules/@babel`);
  await symlink(
    path.dirname(Bun.resolveSync("@babel/parser/package.json", import.meta.dir)),
    `${cwd}/node_modules/@babel/parser`,
  );
  async function check() {
    const child = Bun.spawn(
      [process.execPath, "run", "test", "./tools/mutation-policy.guidance.test.ts"],
      {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...Environment.child(),
          HOME: root,
          XDG_CONFIG_HOME: `${root}/config`,
          XDG_STATE_HOME: `${root}/state`,
        },
      },
    );
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { code, stderr };
  }

  expect((await check()).code).toBe(0);
  await Bun.file(path.join(cwd, topic)).delete();
  const broken = await check();
  expect(broken.code).toBe(1);
  expect(broken.stderr).toContain("the summary points to an existing topic");
});

test("each mutant runs in a sandbox with type checks off and no host-only state", async () => {
  const seen = path.join(root, crypto.randomUUID());
  const cwd = await fixture({
    "docs/agents/testing/mutation-testing.md": "local guidance\n",
    ".agents/skills/dev-skill/SKILL.md": "development skill\n",
    ".agents/skills/.dot-skill/SKILL.md": "hidden development skill\n",
    ".claude/settings.json": "{}\n",
    ".operator/untouched": "unfinished legacy work\n",
    "src/lib/data.ts": "export const data = 1;\n",
    "src/lib/count.ts": "export function count(n: number) { return n + 1; }\n",
    "src/lib/count.test.ts": `import { test, expect } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { count } from "./count.ts";
test("exact", () => {
  writeFileSync(${JSON.stringify(seen)}, JSON.stringify({
    cwd: process.cwd(),
    entries: readdirSync(".").toSorted(),
    guidance: readFileSync("docs/agents/testing/mutation-testing.md", "utf8"),
    data: readFileSync("src/lib/data.ts", "utf8"),
  }));
  expect(count(2)).toBe(3);
});\n`,
  });
  const before = await Array.fromAsync(new Bun.Glob("**").scan({ cwd, dot: true }));
  const result = await mutate(cwd, ["src/lib/count.ts"]);

  expect(result).toMatchObject({
    code: 0,
    stdout:
      "Mutation summary: 0 survivors, 0 untested, 0 incomplete, 2 killed, 0 ignored, 0 skipped. See docs/agents/testing/mutation-testing.md.\n",
  });
  const sandbox = z
    .object({
      cwd: z.string(),
      entries: z.array(z.string()),
      guidance: z.string(),
      data: z.string(),
    })
    .parse(JSON.parse(await Bun.file(seen).text()));
  expect(sandbox).toEqual({
    cwd: expect.stringMatching(/\/\.mutation-\w+\/sandbox\/sandbox-\w+$/) as string,
    entries: ["docs", "node_modules", "package.json", "src"],
    guidance: "local guidance\n",
    // Stryker turns off type checks in sandbox sources, because instrumented code fails strict tsc.
    data: "// @ts-nocheck\nexport const data = 1;\n",
  });
  // Only incremental and campaign evidence stay in the checkout, not the sandbox.
  const after = await Array.fromAsync(new Bun.Glob("**").scan({ cwd, dot: true }));
  expect(after.filter((file) => !before.includes(file)).toSorted()).toEqual([
    expect.stringMatching(
      /^\.mutation-incremental\/src\/lib\/count\.ts\.[\da-f]+\.json$/,
    ) as string,
    expect.stringMatching(/^\.mutation-runs\/[\da-f-]+\.json$/) as string,
  ]);
  expect(before.filter((file) => !after.includes(file))).toEqual([]);
}, 60_000);

test("survivors quote multi-line originals and backticks, and timeouts are incomplete", async () => {
  const cwd = await fixture({
    "src/lib/pick.ts": `export function pick(flag: boolean) {
  if (flag) {
    return \`a\`;
  } else return "b";
}
export function anyPositive(items: number[]) {
  return items.some((item) => {
    return item > 0;
  });
}
export function drain(n: number) {
  while (n > 0) n--;
  return n;
}
`,
    "src/lib/pick.test.ts": `import { test, expect } from "bun:test";
import { anyPositive, drain, pick } from "./pick.ts";
test("weak", () => {
  expect(typeof pick(true)).toBe("string");
  expect(typeof anyPositive([1])).toBe("boolean");
  expect(drain(2)).toBe(0);
});\n`,
  });
  const result = await mutate(cwd, ["src/lib/pick.ts"]);

  expect(result.code).toBe(3);
  expect(result.stdout.split("\n")).toContain(
    "src/lib/pick.ts:7: survived: BlockStatement: `{\\n    return item > 0;\\n  }` to `{}`",
  );
  expect(result.stdout.split("\n")).toContain(
    "src/lib/pick.ts:3: survived: StringLiteral: `\\`a\\`` to `\\`\\``",
  );
  // A multi-line replacement is quoted on one line too.
  const every = result.stdout
    .split("\n")
    .find((line) => line.startsWith("src/lib/pick.ts:7: survived: MethodExpression: "));
  expect(every?.slice(every.indexOf(" to `"))).toStartWith(" to `items.every(");
  expect(every?.slice(every.indexOf(" to `"))).toContain("\\n");
  expect(result.stderr).toContain("src/lib/pick.ts:12: incomplete: Timeout: no result");
  expect(result.stdout).toMatch(/ \d+ survivors, 0 untested, [1-9]\d* incomplete, /);
}, 120_000);

test("the checkout's own runner judges each mutant from the sandbox", async () => {
  const record = path.join(root, crypto.randomUUID());
  const cwd = await fixture({
    // The test script would fail, so a passing run proves that the runner judged the mutants.
    "package.json": JSON.stringify({ type: "module", scripts: { test: "exit 9" } }),
    "tools/test-watchdog.ts": `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(record)}, JSON.stringify({ runner: import.meta.path, cwd: process.cwd(), args: process.argv.slice(2) }) + "\\n");
const child = Bun.spawn([process.execPath, "test", "--isolate", ...process.argv.slice(2)], { stdout: "inherit", stderr: "inherit" });
process.exit(await child.exited);\n`,
    "src/lib/count.ts": "export function count(n: number) { return n + 1; }\n",
    "src/lib/count.test.ts":
      'import { test, expect } from "bun:test"; import { count } from "./count.ts"; test("exact", () => { expect(count(2)).toBe(3); });\n',
  });
  const result = await mutate(cwd, ["src/lib/count.ts"]);

  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toContain("run-completed, passed");
  const run = z.object({ runner: z.string(), cwd: z.string(), args: z.array(z.string()) });
  const runs = (await Bun.file(record).text())
    .trim()
    .split("\n")
    .map((line) => run.parse(JSON.parse(line)));
  // One dry run and one run for each of the two mutants.
  expect(runs).toHaveLength(3);
  for (const recorded of runs) {
    expect(recorded.runner).not.toStartWith(cwd);
    expect(recorded.runner).toContain("/.mutation-");
    expect(recorded.runner).toEndWith("/tools/test-watchdog.ts");
    expect(recorded.cwd).toMatch(/\/\.mutation-\w+\/sandbox\/sandbox-\w+$/);
    expect(recorded.args).toEqual(["--bail", "./src/lib/count.test.ts"]);
  }
  // A changed runner judges every mutant again.
  await Bun.write(record, "");
  const runnerFile = path.join(cwd, "tools/test-watchdog.ts");
  await Bun.write(runnerFile, `${await Bun.file(runnerFile).text()}// changed\n`);
  expect((await mutate(cwd, ["src/lib/count.ts"])).code).toBe(0);
  expect((await Bun.file(record).text()).trim().split("\n")).toHaveLength(3);
}, 60_000);
