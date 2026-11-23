import { afterAll, expect, test } from "bun:test";
import { Environment } from "../src/modules/environment/main.ts";
// Bun has no temporary directory, permission, directory listing, or recursive removal API.
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const script = path.join(import.meta.dir, "prove-module-boundaries.ts");
const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { force: true, recursive: true });
});

const controlledBun = path.join(import.meta.dir, "fixtures/boundary-bun.ts");

const base = {
  ".oxfmtrc.json": "{}\n",
  ".oxlintrc.json": "{}\n",
  "packages/deep-modules/src/index.ts": "export {};\n",
  "src/cli.ts": "export {};\n",
  "src/lib/keep.ts": "export {};\n",
  "src/modules/keep/main.ts": "export {};\n",
  "package.json": "{}\n",
  "tools/keep.ts": "export {};\n",
  "tools/oxlint/keep.ts": "export {};\n",
  "tsconfig.json": "{}\n",
};

/** A source root with the copied entries, files the proof must not copy, and a controlled Bun. */
async function sourceRoot(
  wrongRun: number,
  fault: { files: string[]; rule: string; kind: string } | null,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "operator-boundary-source-"));
  roots.push(root);
  for (const [name, text] of Object.entries({
    ...base,
    "outside.txt": "not copied\n",
    "outside/skip.ts": "export {};\n",
    "node_modules/marker.txt": "linked\n",
    "bin/bun": `#!/bin/sh\nexec ${[
      process.execPath,
      controlledBun,
      path.join(root, "calls"),
      String(wrongRun),
      JSON.stringify(fault ?? {}),
    ]
      .map((argument) => "'" + argument.replaceAll("'", "'\\''") + "'")
      .join(" ")} "$@"\n`,
  })) {
    await Bun.write(path.join(root, name), text);
  }
  await chmod(path.join(root, "bin/bun"), 0o755);
  await mkdir(path.join(root, "temporary"));
  await mkdir(path.join(root, "calls"));
  return root;
}

const identity = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

async function readCall(directory: string) {
  const files: Record<string, string> = {};
  const tree = path.join(directory, "tree");
  for await (const name of new Bun.Glob("**/*").scan({ cwd: tree, dot: true })) {
    if (!name.startsWith("node_modules/")) {
      files[name.replaceAll(identity, "ID")] = (
        await Bun.file(path.join(tree, name)).text()
      ).replaceAll(identity, "ID");
    }
  }
  return {
    check: await Bun.file(path.join(directory, "check")).text(),
    root: (await Bun.file(path.join(directory, "root")).text()).startsWith(
      "operator-module-boundaries-",
    ),
    linked: await Bun.file(path.join(tree, "node_modules/marker.txt")).exists(),
    files,
  };
}

async function prove(
  wrongRun = 0,
  fault: { files: string[]; rule: string; kind: string } | null = null,
) {
  const root = await sourceRoot(wrongRun, fault);
  const log = path.join(root, "calls");
  const child = Bun.spawn([process.execPath, script], {
    cwd: root,
    env: Environment.child({
      // Only the controlled Bun is on PATH. No Python or other language runtime is available.
      PATH: path.join(root, "bin"),
      TMPDIR: path.join(root, "temporary"),
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const count = (await readdir(log)).length;
  const calls = [];
  for (let index = 1; index <= count; index++) {
    calls.push(await readCall(path.join(log, String(index))));
  }
  return {
    exitCode,
    stdout,
    stderr,
    calls,
    leftCopies: await readdir(path.join(root, "temporary")),
  };
}

const valid = {
  "src/lib/module-boundary-probe-valid-ID/value.ts": "export function value() { return 1; }\n",
  "src/lib/module-boundary-probe-valid-ID/consumer.ts":
    'import { value } from "./value.ts";\n\nexport function twice() { return value() * 2; }\n',
  "src/modules/module-boundary-probe-valid-ID/main.ts":
    'import { value } from "../../lib/module-boundary-probe-valid-ID/value.ts";\n\nexport const ValidProbe = { run() { return value(); } };\n',
  "src/modules/module-boundary-probe-valid-ID/main.test.ts":
    'import { expect, test } from "bun:test";\nimport { ValidProbe } from "./main.ts";\n\ntest("returns the library value", () => { expect(ValidProbe.run()).toBe(1); });\n',
};

const violations: { name: string; check: string; files: Record<string, string>; rule?: string }[] =
  [
    {
      name: "private module import",
      rule: "deep-modules(module-imports)",
      check: "lint",
      files: {
        "module-boundary-probe-ID.test.ts": 'require("./src/modules/operator-cli/run.ts");\n',
      },
    },
    {
      name: "root configuration private type import",
      rule: "deep-modules(module-imports)",
      check: "lint",
      files: {
        "module-boundary-probe-ID.config.ts":
          'export type Private = typeof import("./src/modules/operator-cli/run.ts");\n',
      },
    },
    {
      name: "outside access to a nested entry",
      rule: "deep-modules(module-imports)",
      check: "lint",
      files: {
        "src/modules/module-boundary-probe-nested-ID/child/grandchild/main.ts":
          "export function run() {}\n",
        "src/modules/module-boundary-probe-nested-ID/main.ts":
          'import "./child/grandchild/main.ts";\nexport const NestedProbe = { run() {} };\n',
      },
    },
    {
      name: "missing module interface",
      check: "lint:modules",
      files: { "src/modules/module-boundary-probe-missing-ID/private.ts": "export {};\n" },
    },
    {
      name: "missing module entry test",
      check: "lint:modules",
      files: {
        "src/modules/module-boundary-probe-entry-test-ID/main.ts":
          "export const EntryTest = { run() {} };\n",
      },
    },
    {
      name: "missing nested interface",
      check: "lint:modules",
      files: {
        "src/modules/module-boundary-probe-child-ID/main.ts":
          "export const ChildProbe = { run() {} };\n",
        "src/modules/module-boundary-probe-child-ID/main.test.ts": "export {};\n",
        "src/modules/module-boundary-probe-child-ID/child/private.tsx": "export {};\n",
      },
    },
    {
      name: "standalone application operation",
      rule: "deep-modules(module-interface)",
      check: "lint",
      files: {
        "src/modules/module-boundary-probe-data-ID/main.ts":
          "export const DataInterface = () => true;\n",
      },
    },
    {
      name: "multiple application interfaces",
      rule: "deep-modules(module-interface)",
      check: "lint",
      files: {
        "src/modules/module-boundary-probe-barrel-ID/main.ts":
          "export const BarrelInterface = { run() {} };\nexport const Other = { stop() {} };\n",
        "src/modules/module-boundary-probe-barrel-ID/helper.ts": "export function helper() {}\n",
      },
    },
    {
      name: "flat production module file",
      check: "lint:modules",
      files: { "src/modules/module-boundary-probe-ID.ts": "export {};\n" },
    },
    {
      name: "production code outside modules",
      check: "lint:modules",
      files: { "module-boundary-probe-ID.ts": "export {};\n" },
    },
    {
      name: "lib importing a module interface",
      rule: "deep-modules(lib-imports)",
      check: "lint",
      files: {
        "src/lib/module-boundary-probe-interface-ID.ts":
          'export { OperatorCli } from "../modules/operator-cli/main.ts";\n',
      },
    },
    {
      name: "lib importing private module code",
      rule: "deep-modules(lib-imports)",
      check: "lint",
      files: {
        "src/lib/module-boundary-probe-private-ID.ts":
          'const run = import("../modules/operator-cli/run.ts");\n',
      },
    },
    {
      name: "lib requiring application code",
      rule: "deep-modules(lib-imports)",
      check: "lint",
      files: { "src/lib/module-boundary-probe-require-ID.ts": 'require("../cli.ts");\n' },
    },
    {
      name: "module dependency cycle",
      rule: "import(no-cycle)",
      check: "lint",
      files: {
        "src/modules/module-boundary-probe-cycle-ID/main.ts":
          'import "./worker.ts";\nexport const CycleProbe = { run() {} };\n',
        "src/modules/module-boundary-probe-cycle-ID/worker.ts": 'import "./main.ts";\n',
      },
    },
    {
      name: "module importing another module's private code",
      rule: "deep-modules(module-imports)",
      check: "lint",
      files: {
        "src/modules/module-boundary-probe-private-ID/main.ts":
          'import "../operator-cli/run.ts";\nexport const PrivateProbe = { run() {} };\n',
      },
    },
    {
      name: "lib dependency cycle",
      rule: "import(no-cycle)",
      check: "lint",
      files: {
        "src/lib/module-boundary-probe-cycle-ID/a.ts": 'import "./b.ts";\n',
        "src/lib/module-boundary-probe-cycle-ID/b.ts": 'import "./a.ts";\n',
      },
    },
    {
      name: "lib importing an application type",
      rule: "deep-modules(lib-imports)",
      check: "lint",
      files: {
        "src/lib/module-boundary-probe-type-ID.ts":
          'export type App = typeof import("../modules/operator-cli/main.ts");\n',
      },
    },
    {
      name: "lib using an import-equals application reference",
      rule: "deep-modules(lib-imports)",
      check: "lint",
      files: {
        "src/lib/module-boundary-probe-equals-ID.ts":
          'import App = require("../modules/operator-cli/main.ts");\n',
      },
    },
    {
      name: "parent test mocking a private implementation",
      rule: "deep-modules(public-collaborator-mocks)",
      check: "lint",
      files: {
        "src/modules/module-boundary-probe-mock-ID/main.test.ts":
          'import { mock } from "bun:test";\nawait mock.module("../operator-cli/run.ts", () => ({}));\n',
      },
    },
    {
      name: "parent-local query and mutation groups",
      rule: "deep-modules(query-options-owner)",
      check: "lint",
      files: {
        "src/modules/module-boundary-probe-query-ID/main.ts":
          "export const QueryProbe = { queryOptions: { find() {} }, mutationOptions: { save() {} } };\n",
      },
    },
    {
      name: "explicit async selector",
      rule: "deep-modules(synchronous-selectors)",
      check: "lint",
      files: {
        "src/modules/module-boundary-probe-selector-ID/main.ts":
          "export const SelectorProbe = { selector: { async isReleased() { return true; } } };\n",
      },
    },
    {
      name: "lib type error",
      check: "typecheck",
      files: { "src/lib/type-probe-ID.ts": 'export const count: number = "wrong";\n' },
    },
    {
      name: "lib formatting error",
      check: "format:check",
      files: { "src/lib/format-probe-ID.ts": "export const count=1;\n" },
    },
    {
      name: "lib lint error",
      rule: "anti-slop(no-reflect-get)",
      check: "lint",
      files: { "src/lib/lint-probe-ID.ts": 'export const item = Reflect.get({}, "value");\n' },
    },
  ];

function call(check: string, files: Record<string, string> = {}) {
  return { check, root: true, linked: true, files: { ...base, ...files } };
}

const batchedFiles: Record<string, string> = {};
for (const violation of violations)
  if (violation.check === "lint") Object.assign(batchedFiles, violation.files);

const calls = [
  call("lint:modules"),
  call("format", valid),
  call("lint:modules", valid),
  call("lint", valid),
  call("typecheck", valid),
  call("format:check", valid),
  call("lint", batchedFiles),
  ...violations
    .filter((violation) => violation.check !== "lint")
    .map((violation) => call(violation.check, violation.files)),
  call("lint:modules"),
  call("lint"),
  call("typecheck"),
  call("format:check"),
];

test("runs every check in a removed copy and reports the rejected violations", async () => {
  const result = await prove();

  expect(result).toMatchObject({
    exitCode: 0,
    stdout: "module boundaries: clean -> rejected 24 deliberate violations -> clean\n",
    stderr: "",
    leftCopies: [],
  });
  expect(result.calls).toEqual(calls);
});

const failures = [
  "The clean module graph did not pass",
  "Could not format valid module and lib examples",
  "Focused lib imports and named exports did not pass",
  "Valid module-to-lib import failed lint",
  "Valid module-to-lib import failed typecheck",
  "Valid module-to-lib import failed format:check",
  "private module import was not rejected",
  ...violations
    .filter((violation) => violation.check !== "lint")
    .map((violation) => `${violation.name} was not rejected`),
  "The restored module graph did not pass",
  "The restored project did not pass lint",
  "The restored project did not pass typecheck",
  "The restored project did not pass format:check",
];

test.concurrent.each(failures.map((message, index) => [index + 1, message] as const))(
  "a failed call %d stops the proof with: %s",
  async (run, message) => {
    const result = await prove(run);

    expect(result.exitCode).toBe(1);
    // The source line is in the trace too, so match the thrown error line itself.
    expect(result.stderr).toContain(`AssertionError: ${message}\n`);
    expect(result.calls).toEqual(calls.slice(0, run));
    expect(result.leftCopies).toEqual([]);
    // Only the failed check's output reaches the caller; the format call reports nothing.
    expect(result.stdout).toBe(run === 2 ? "" : "fake " + calls[run - 1]?.check + " output\n");
  },
);

const lintViolations = violations.filter((violation) => violation.check === "lint");
test.concurrent.each(lintViolations)(
  "the batched proof refuses a matching rule at another location for $name",
  async (violation) => {
    const result = await prove(0, {
      files: Object.keys(violation.files),
      rule: violation.rule ?? "",
      kind: "file",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`AssertionError: ${violation.name} was not rejected\n`);
    expect(result.leftCopies).toEqual([]);
  },
);

test.concurrent.each(["line", "rule"])("the batched proof refuses the wrong %s", async (kind) => {
  const result = await prove(0, {
    files: ["module-boundary-probe-ID.test.ts"],
    rule: "deep-modules(module-imports)",
    kind,
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("AssertionError: private module import was not rejected\n");
  expect(result.leftCopies).toEqual([]);
});
