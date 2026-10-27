import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no recursive copy, temporary-directory, or symlink API.
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";

const source = Bun.fileURLToPath(new URL("../../", import.meta.url));
let root = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-source-reset-guards-"));
  for (const file of [
    "modules",
    "lib",
    "scripts",
    "tools",
    "skills",
    "cli.ts",
    "package.json",
    "bunfig.toml",
    "tsconfig.json",
  ])
    await cp(`${source}/${file}`, `${root}/${file}`, { recursive: true });
  await symlink(`${source}/node_modules`, `${root}/node_modules`);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const reset = "reset preserves merged and completed work";
const refusals = "every other reset refusal";
const prune = "prune deletes an ended source only after 14 days";
const failed = "failed file deletion keeps the source";
const cleanup = "an open cleanup keeps its ended source visible";

test.each([
  {
    name: "person instruction",
    file: "work-sources/main.ts",
    before: "if (!input.personInstructed)",
    after: "if (false)",
    pattern: reset,
  },
  {
    name: "no running worker",
    file: "work-sources/source-machine.ts",
    before: "if (facts.workers.length > 0)",
    after: "if (false)",
    pattern: reset,
  },
  {
    name: "completed work preserved",
    file: "work-sources/source-machine.ts",
    before: "!complete(assignment) && assignment.state",
    after: "true && assignment.state",
    pattern: reset,
  },
  {
    name: "only an open source resets",
    file: "work-sources/source-machine.ts",
    before: 'if (facts.state !== "open")',
    after: "if (false)",
    pattern: refusals,
  },
  {
    name: "source of this project",
    file: "device-state/sources.ts",
    before:
      ".where(and(eq(sources.id, target.sourceId), eq(sources.repository, target.repository)))",
    after: ".where(eq(sources.id, target.sourceId))",
    pattern: refusals,
  },
  {
    name: "14-day retention",
    file: "work-sources/source-machine.ts",
    before: "if (facts.now < ended + retentionMs)",
    after: "if (false)",
    pattern: prune,
  },
  {
    name: "prune offered in next",
    file: "work-sources/main.ts",
    before: '...(kept.prune ? [{ action: "prune_source", reason: "retention_elapsed" }] : []),',
    after: "",
    pattern: prune,
  },
  {
    name: "prune deletes device-state files",
    file: "device-state/sources.ts",
    before: "const removed = removeStateDirectory(",
    after: "const removed = Ok(undefined) ?? removeStateDirectory(",
    pattern: prune,
  },
  {
    name: "failed deletion keeps the records",
    file: "device-state/sources.ts",
    before: '"source_prune_failed",\n        );',
    after: '"source_prune_failed",\n        ) && Ok(undefined);',
    pattern: failed,
  },
  {
    name: "retained work still exists",
    file: "device-state/sources.ts",
    before: "path === null || !existsSync(path) ||",
    after: "path === null ||",
    pattern: reset,
  },
  {
    name: "refusal names the worker pane",
    file: "work-sources/source-machine.ts",
    before: "(pane $" + '{paneId ?? "not created yet"})',
    after: "",
    pattern: reset,
  },
  {
    name: "open cleanup keeps the source",
    file: "work-sources/source-machine.ts",
    before: "if (facts.cleanupOpen)",
    after: "if (false)",
    pattern: cleanup,
  },
  {
    name: "a stopped recursive removal is an I/O failure",
    file: "device-state/failures.ts",
    before: '"ENOTEMPTY",',
    after: "",
    pattern: "qualifies known SQLite and filesystem failures",
    testFile: "device-state/failures.test.ts",
  },
  {
    name: "running worker keeps the source",
    file: "work-sources/source-machine.ts",
    before: "if (facts.workerRunning)",
    after: "if (false)",
    pattern: "prune keeps open sources",
    testFile: "work-sources/source-machine.test.ts",
  },
])(
  "a deliberate break of source reset guard $name makes its behavior test fail",
  async (change) => {
    const file = `${root}/modules/${change.file}`;
    const original = await Bun.file(file).text();
    expect(original).toContain(change.before);
    try {
      await Bun.write(file, original.replace(change.before, change.after));
      const child = Bun.spawn(
        [
          process.execPath,
          "test",
          "--timeout=60000",
          `modules/${"testFile" in change ? change.testFile : "operator-cli/run.source-reset.test.ts"}`,
          "--test-name-pattern",
          change.pattern,
        ],
        {
          cwd: root,
          env: Environment.child({ BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, `${stdout}${stderr}`).toBe(1);
      expect(`${stdout}${stderr}`).toContain("(fail)");
      expect(`${stdout}${stderr}`).toContain(change.pattern);
    } finally {
      await Bun.write(file, original);
    }
  },
  180000,
);
