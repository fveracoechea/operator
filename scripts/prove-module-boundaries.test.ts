import { afterAll, expect, test } from "bun:test";
import { Environment } from "../modules/environment/main.ts";
// Bun has no temporary directory, permission, directory listing, or recursive removal API.
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const script = path.join(import.meta.dir, "prove-module-boundaries.ts");
const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { force: true, recursive: true });
});

const diagnostics = [
  "imports private module file",
  "every module requires one public interface",
  "properties are action methods",
  "must export exactly one variable statement",
  "production files must be inside a feature module",
  "production TypeScript must live",
  "lib must not import application or tooling code",
  "import(no-cycle)",
  "is not assignable to type 'number'",
  "anti-slop(no-reflect-get)",
];

// The controlled Bun keeps a copy of the tree each check sees and rejects a tree that holds a
// probe file. The call that WRONG_RUN names fails with an unrelated diagnostic.
const fakeBun = `#!/bin/sh
[ "$1" = run ] || exit 9
n=$(( $(ls "$PROBE_LOG" | wc -l) + 1 ))
mkdir -p "$PROBE_LOG/$n"
printf '%s' "$2" > "$PROBE_LOG/$n/check"
basename "$PWD" > "$PROBE_LOG/$n/root"
cp -R . "$PROBE_LOG/$n/tree"
echo "fake $2 output"
if [ "$n" = "$WRONG_RUN" ]; then echo "unrelated diagnostic" >&2; exit 1; fi
probes=$(find . -path ./node_modules -prune -o -type f -path '*probe*' -print | grep -v -e -valid-)
[ -z "$probes" ] && exit 0
printf '%s\\n' ${diagnostics.map((text) => `'${text.replaceAll("'", "'\\''")}'`).join(" ")} $probes >&2
exit 1
`;

const base = {
  ".oxfmtrc.json": "{}\n",
  ".oxlintrc.json": "{}\n",
  "cli.ts": "export {};\n",
  "lib/keep.ts": "export {};\n",
  "modules/keep/main.ts": "export {};\n",
  "package.json": "{}\n",
  "scripts/keep.ts": "export {};\n",
  "tools/oxlint/keep.ts": "export {};\n",
  "tsconfig.json": "{}\n",
};

/** A source root with the copied entries, files the proof must not copy, and a controlled Bun. */
async function sourceRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "operator-boundary-source-"));
  roots.push(root);
  for (const [name, text] of Object.entries({
    ...base,
    "outside.txt": "not copied\n",
    "tools/other/skip.ts": "export {};\n",
    "node_modules/marker.txt": "linked\n",
    "bin/bun": fakeBun,
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

async function prove(wrongRun = 0) {
  const root = await sourceRoot();
  const log = path.join(root, "calls");
  const child = Bun.spawn([process.execPath, script], {
    cwd: root,
    env: Environment.child({
      PATH: `${path.join(root, "bin")}:${Environment.read().PATH}`,
      TMPDIR: path.join(root, "temporary"),
      PROBE_LOG: log,
      WRONG_RUN: String(wrongRun),
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
  "lib/module-boundary-probe-valid-ID/value.ts": "export function value() { return 1; }\n",
  "lib/module-boundary-probe-valid-ID/consumer.ts":
    'import { value } from "./value.ts";\n\nexport function twice() { return value() * 2; }\n',
  "modules/module-boundary-probe-valid-ID/main.ts":
    'import { value } from "../../lib/module-boundary-probe-valid-ID/value.ts";\n\nexport const ValidProbe = { run() { return value(); } };\n',
};

const violations: { name: string; check: string; files: Record<string, string> }[] = [
  {
    name: "private module import",
    check: "lint:modules",
    files: { "module-boundary-probe-ID.test.ts": 'require("./modules/operator-cli/run.ts");\n' },
  },
  {
    name: "missing module interface",
    check: "lint:modules",
    files: { "modules/module-boundary-probe-missing-ID/private.ts": "export {};\n" },
  },
  {
    name: "data-only module interface",
    check: "lint:modules",
    files: {
      "modules/module-boundary-probe-data-ID/main.ts":
        "export const DataInterface = { value: true };\n",
    },
  },
  {
    name: "barrel module interface",
    check: "lint:modules",
    files: {
      "modules/module-boundary-probe-barrel-ID/main.ts":
        'export const BarrelInterface = { run() {} };\nexport { helper } from "./helper.ts";\n',
      "modules/module-boundary-probe-barrel-ID/helper.ts": "export function helper() {}\n",
    },
  },
  {
    name: "flat production module file",
    check: "lint:modules",
    files: { "modules/module-boundary-probe-ID.ts": "export {};\n" },
  },
  {
    name: "production code outside modules",
    check: "lint:modules",
    files: { "module-boundary-probe-ID.ts": "export {};\n" },
  },
  {
    name: "lib importing a module interface",
    check: "lint:modules",
    files: {
      "lib/module-boundary-probe-ID.ts":
        'export { OperatorCli } from "../modules/operator-cli/main.ts";\n',
    },
  },
  {
    name: "lib importing private module code",
    check: "lint:modules",
    files: {
      "lib/module-boundary-probe-ID.ts": 'const run = import("../modules/operator-cli/run.ts");\n',
    },
  },
  {
    name: "lib requiring application code",
    check: "lint:modules",
    files: { "lib/module-boundary-probe-ID.ts": 'require("../cli.ts");\n' },
  },
  {
    name: "module dependency cycle",
    check: "lint",
    files: {
      "modules/module-boundary-probe-cycle-ID/main.ts":
        'import "./worker.ts";\nexport const CycleProbe = { run() {} };\n',
      "modules/module-boundary-probe-cycle-ID/worker.ts": 'import "./main.ts";\n',
    },
  },
  {
    name: "module importing another module's private code",
    check: "lint:modules",
    files: {
      "modules/module-boundary-probe-private-ID/main.ts":
        'import "../operator-cli/run.ts";\nexport const PrivateProbe = { run() {} };\n',
    },
  },
  {
    name: "lib dependency cycle",
    check: "lint",
    files: {
      "lib/module-boundary-probe-cycle-ID/a.ts": 'import "./b.ts";\n',
      "lib/module-boundary-probe-cycle-ID/b.ts": 'import "./a.ts";\n',
    },
  },
  {
    name: "lib importing an application type",
    check: "lint:modules",
    files: {
      "lib/module-boundary-probe-ID.ts":
        'export type App = typeof import("../modules/operator-cli/main.ts");\n',
    },
  },
  {
    name: "lib using an import-equals application reference",
    check: "lint:modules",
    files: {
      "lib/module-boundary-probe-ID.ts":
        'import App = require("../modules/operator-cli/main.ts");\n',
    },
  },
  {
    name: "lib type error",
    check: "typecheck",
    files: { "lib/type-probe-ID.ts": 'export const count: number = "wrong";\n' },
  },
  {
    name: "lib formatting error",
    check: "format:check",
    files: { "lib/format-probe-ID.ts": "export const count=1;\n" },
  },
  {
    name: "lib lint error",
    check: "lint",
    files: { "lib/lint-probe-ID.ts": 'export const item = Reflect.get({}, "value");\n' },
  },
];

function call(check: string, files: Record<string, string> = {}) {
  return { check, root: true, linked: true, files: { ...base, ...files } };
}

const calls = [
  call("lint:modules"),
  call("format", valid),
  call("lint:modules", valid),
  call("lint", valid),
  call("typecheck", valid),
  call("format:check", valid),
  ...violations.map((violation) => call(violation.check, violation.files)),
  call("lint:modules"),
];

test("runs every check in a removed copy and reports the rejected violations", async () => {
  const result = await prove();

  expect(result).toMatchObject({
    exitCode: 0,
    stdout: "module boundaries: clean -> rejected 17 deliberate violations -> clean\n",
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
  ...violations.map((violation) => `${violation.name} was not rejected`),
  "The restored module graph did not pass",
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
