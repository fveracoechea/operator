import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no recursive copy, temporary-directory, or symlink API.
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";

const source = Bun.fileURLToPath(new URL("../../../", import.meta.url));
let root = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-assignment-ending-guards-"));
  for (const file of ["src", "tools", "skills", "package.json", "bunfig.toml", "tsconfig.json"])
    await cp(`${source}/${file}`, `${root}/${file}`, { recursive: true });
  await symlink(`${source}/node_modules`, `${root}/node_modules`);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test.each([
  {
    name: "live pane probe",
    file: "work-sources/missing-workers.ts",
    before: "if (pane.value === null && !names.has(worker.name))",
    after: "if (false)",
    pattern: "an assignment whose worker and worktree are gone ends",
  },
  {
    name: "worktree retention",
    file: "work-sources/main.ts",
    before: "lstatSync(launch.worktreePath, { throwIfNoEntry: false }) === undefined",
    after: "true",
    pattern: "an assignment whose worker and worktree are gone ends",
  },
  {
    name: "one assignment only",
    file: "device-state/sources.ts",
    before: "inArray(assignments.key, abandon)",
    after: "true",
    pattern: "abandon ends one assignment and deletes nothing",
  },
  {
    name: "changed environment protection",
    file: "worktree-preparation/main.ts",
    before: "return changed;",
    after: "return [];",
    pattern: "cleanup ignores ignored entries except changed env files",
  },
  {
    name: "missing named agent",
    file: "work-sources/missing-workers.ts",
    before: "pane.value === null && !names.has(worker.name)",
    after: "pane.value === null",
    pattern: "live panes, moved named agents, and another Herdr session",
  },
])(
  "a deliberate break of $name fails its lifecycle behavior test",
  async (change) => {
    const file = `${root}/src/modules/${change.file}`;
    const original = await Bun.file(file).text();
    expect(original).toContain(change.before);
    try {
      await Bun.write(file, original.replace(change.before, change.after));
      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          "test",
          "src/modules/operator-cli/run.assignment-ending.test.ts",
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
