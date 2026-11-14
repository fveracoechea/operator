import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { Environment } from "../src/modules/environment/main.ts";
// Bun has no temporary directory or recursive removal API.
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

// Most tests run Stryker, which starts several Bun processes, so a busy machine needs time.
setDefaultTimeout(60_000);
// The real path, because Bun reports a script path with symlinks such as macOS /var resolved.
const root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-mutate-")));
const script = path.join(import.meta.dir, "mutate.ts");

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function mutate(cwd: string, args: string[]) {
  const child = Bun.spawn([process.execPath, script, ...args], {
    cwd,
    env: {
      ...Environment.child(),
      HOME: root,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
    },
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

async function fixture(files: Record<string, string>): Promise<string> {
  const cwd = path.join(root, crypto.randomUUID());
  await Bun.write(
    path.join(cwd, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: { test: "bun test --isolate" },
    }),
  );
  await symlink(path.resolve(import.meta.dir, "../node_modules"), path.join(cwd, "node_modules"));
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
  ).toEqual([]);
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
  ).toEqual([]);
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
    entries: ["docs", "package.json", "src"],
    guidance: "local guidance\n",
    // Stryker turns off type checks in sandbox sources, because instrumented code fails strict tsc.
    data: "// @ts-nocheck\nexport const data = 1;\n",
  });
  // Only the ignored incremental result stays in the checkout. No report or temporary folder does.
  const after = await Array.fromAsync(new Bun.Glob("**").scan({ cwd, dot: true }));
  expect(after.filter((file) => !before.includes(file))).toEqual([
    expect.stringMatching(
      /^\.mutation-incremental\/src\/lib\/count\.ts\.[\da-f]+\.json$/,
    ) as string,
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

  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
  const run = z.object({ runner: z.string(), cwd: z.string(), args: z.array(z.string()) });
  const runs = (await Bun.file(record).text())
    .trim()
    .split("\n")
    .map((line) => run.parse(JSON.parse(line)));
  // One dry run and one run for each of the two mutants.
  expect(runs).toHaveLength(3);
  for (const recorded of runs) {
    expect(recorded.runner).toBe(path.join(cwd, "tools/test-watchdog.ts"));
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
