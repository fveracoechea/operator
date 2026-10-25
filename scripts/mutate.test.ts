import { afterAll, expect, test } from "bun:test";
// Bun has no temporary directory or recursive removal API.
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "operator-mutate-"));
const script = path.join(import.meta.dir, "mutate.ts");

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function mutate(cwd: string, args: string[]) {
  const child = Bun.spawn([process.execPath, script, ...args], {
    cwd,
    env: {
      ...process.env,
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
      ...process.env,
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

test("a weak beside-test reports actionable survivors in fresh Bun processes", async () => {
  const processes = path.join(root, crypto.randomUUID());
  const cwd = await fixture({
    "lib/count.ts": "export function count(n: number) { return n + 1; }\n",
    "lib/count.test.ts": `import { test, expect } from "bun:test";
import { appendFileSync } from "node:fs";
import { count } from "./count.ts";
test("weak", () => {
  appendFileSync(${JSON.stringify(processes)}, process.pid + "\\n");
  expect(typeof count(2)).toBe("number");
});\n`,
    "lib/other.test.ts":
      'import { test } from "bun:test"; test("not selected", () => { throw new Error("wrong test"); });\n',
  });
  const result = await mutate(cwd, ["lib/count.test.ts"]);
  expect(result.code).toBe(2);
  expect(result.stdout).toMatch(
    /lib\/count.ts:1: survived: ArithmeticOperator: `n \+ 1` to `n - 1`/,
  );
  expect(result.stdout).toContain(".agents/skills/unit-testing/mutation-testing.md");
  const pids = (await Bun.file(processes).text()).trim().split("\n");
  expect(pids.length).toBeGreaterThan(1);
  expect(new Set(pids).size).toBe(pids.length);
  expect(await Bun.file(path.join(cwd, "lib/count.ts")).text()).toBe(
    "export function count(n: number) { return n + 1; }\n",
  );
}, 30_000);

test("missing direct tests do not borrow a module interface test", async () => {
  const cwd = await fixture({
    "modules/sample/private.ts": "export const number = 1;\n",
    "modules/sample/main.test.ts":
      'import { test } from "bun:test"; test("interface", () => {});\n',
  });
  const result = await mutate(cwd, ["modules/sample/private.ts"]);
  expect(result.code).toBe(2);
  expect(result.stdout).toContain("modules/sample/private.ts: untested");
  expect(
    await Array.fromAsync(new Bun.Glob(".mutation-*").scan({ cwd, onlyFiles: false })),
  ).toEqual([]);
});

test("scenario paths select their unit and only that unit's beside-tests run", async () => {
  const cwd = await fixture({
    "tsconfig.json": "{}\n",
    ".agents/skills/unit-testing/mutation-testing.md": "local guidance\n",
    ".operator/untouched": "unfinished legacy work\n",
    "modules/sample/main.ts": "export function count(n: number) { return n + 1; }\n",
    "modules/sample/main.scenario.test.ts":
      'import { test, expect } from "bun:test"; import { existsSync } from "node:fs"; import { count } from "./main.ts"; test("exact", () => { expect(count(2)).toBe(3); expect(existsSync(".operator")).toBe(false); expect(existsSync(".agents/skills/host-skill")).toBe(false); expect(existsSync(".agents/skills/unit-testing/mutation-testing.md")).toBe(true); });\n',
    "modules/sample/unrelated.test.ts": "throw new Error('must not run');\n",
  });
  await symlink(root, path.join(cwd, ".agents/skills/host-skill"));
  const result = await mutate(cwd, ["modules/sample/main.scenario.test.ts"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("0 survivors");
});

test.each([
  "Stryker disable next-line ArithmeticOperator: too hard",
  "Stryker disable next-line ALL: no rule: blanket skip",
  "Stryker disable next-line StringLiteral, All: equivalent: blanket skip",
])("invalid suppression %s refuses all targets before tests run", async (suppression) => {
  const cwd = await fixture({
    "lib/good.ts": "export const value = 1;\n",
    "lib/good.test.ts": "throw new Error('must not run');\n",
    "lib/bad.ts": `// ${suppression}\nexport const value = 1 + 2;\n`,
  });
  const result = await mutate(cwd, ["lib/good.ts", "lib/bad.ts"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("lib/bad.ts:1");
  expect(result.stderr).toContain("equivalent:");
  expect(
    await Array.fromAsync(new Bun.Glob(".mutation-*").scan({ cwd, onlyFiles: false })),
  ).toEqual([]);
});

test("fixtures, generated code, and the top-of-file no-logic opt-out need no tests", async () => {
  const cwd = await fixture({
    "lib/data-fixture.ts": "throw new Error('fixture');\n",
    "lib/schema.generated.ts": "throw new Error('generated');\n",
    "lib/generated/schema.ts": "throw new Error('generated folder');\n",
    "lib/fixtures/data.ts": "throw new Error('fixture folder');\n",
    "lib/types.ts": "// Stryker disable all: no logic\nexport type Name = string;\n",
  });
  const result = await mutate(cwd, [
    "lib/data-fixture.ts",
    "lib/schema.generated.ts",
    "lib/generated/schema.ts",
    "lib/fixtures/data.ts",
    "lib/types.ts",
  ]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("5 skipped");
});

test("--since uses only changed lines against a real explicit Git ref", async () => {
  const unit = "lib/count [one]'s.ts";
  const cwd = await fixture({
    [unit]:
      "export function old(n: number) { return n - 1; }\nexport function count(n: number) { return n + 1; }\n",
    "lib/count [one]'s.test.ts": `import { test, expect } from "bun:test"; import { old, count } from "./count [one]'s.ts";
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
    "lib/count.ts": "export function count(n: number) { return n + 1; }\n",
    "lib/count.test.ts":
      'import { test, expect } from "bun:test"; import { count } from "./count.ts"; test("broken baseline", () => { expect(count(2)).toBe(99); });\n',
  });
  const result = await mutate(cwd, ["lib/count.ts"]);
  expect(result.code).toBe(3);
  expect(result.stderr).toContain("Mutation execution incomplete");
  expect(
    await Array.fromAsync(new Bun.Glob(".mutation-*").scan({ cwd, onlyFiles: false })),
  ).toEqual([]);
});

test("--since includes new untracked units, skips deletions, and refuses a bad ref", async () => {
  const cwd = await fixture({
    "lib/removed.ts": "export const n = 1;\n",
    ".gitignore": "node_modules/\n.mutation-*/\n",
  });
  git(cwd, "init", "--quiet");
  git(cwd, "add", ".");
  git(cwd, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "baseline");
  expect((await mutate(cwd, ["--since", "HEAD"])).code).toBe(0);
  await Bun.file(path.join(cwd, "lib/removed.ts")).delete();
  await Bun.write(path.join(cwd, "lib/new.ts"), "export const n = 2;\n");
  const result = await mutate(cwd, ["--since", "HEAD"]);
  expect(result.code).toBe(2);
  expect(result.stdout).toContain("lib/new.ts: untested");
  expect(result.stdout).not.toContain("lib/removed.ts");
  expect((await mutate(cwd, ["--since", "not-a-real-ref"])).code).toBe(1);
});

test("valid local suppressions are ignored, not reported as killed", async () => {
  const cwd = await fixture({
    "lib/count.ts":
      "// Stryker disable next-line ArithmeticOperator: no rule: this fixture only promises a numeric result\nexport function count(n: number) { return n + 1; }\n",
    "lib/count.test.ts":
      'import { test, expect } from "bun:test"; import { count } from "./count.ts"; test("numeric", () => { expect(typeof count(2)).toBe("number"); });\n',
  });
  const result = await mutate(cwd, ["lib/count.ts"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("1 killed, 1 ignored");
});

test("case-insensitive wildcard suppressions cannot hide survivors", async () => {
  const cwd = await fixture({
    "lib/count.ts":
      "// Stryker disable next-line ALL: no rule: blanket skip\nexport function count(n: number) { return n + 1; }\n",
    "lib/count.test.ts":
      'import { test, expect } from "bun:test"; import { count } from "./count.ts"; test("weak", () => { expect(typeof count(2)).toBe("number"); });\n',
  });
  expect((await mutate(cwd, ["lib/count.ts"])).code).toBe(1);
});

test("removing the summary's guidance topic makes its real check fail", async () => {
  const topic = ".agents/skills/unit-testing/mutation-testing.md";
  const cwd = await fixture({
    "scripts/mutation-policy.guidance.test.ts": await Bun.file(
      path.join(import.meta.dir, "mutation-policy.guidance.test.ts"),
    ).text(),
    "scripts/mutation-policy.ts": await Bun.file(
      path.join(import.meta.dir, "mutation-policy.ts"),
    ).text(),
    [topic]: await Bun.file(path.resolve(import.meta.dir, "..", topic)).text(),
  });
  async function check() {
    const child = Bun.spawn(
      [process.execPath, "run", "test", "./scripts/mutation-policy.guidance.test.ts"],
      {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
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
