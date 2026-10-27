import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no recursive copy, temporary-directory, or symlink API.
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";

const source = Bun.fileURLToPath(new URL("../../", import.meta.url));
let root = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-project-management-guards-"));
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

test.each([
  {
    name: "inaccessible controller visibility",
    file: "projects/main.ts",
    section: "list(paths:",
    before: 'controller = { status: "blocked", ...error };',
    after: "throw cause;",
    unit: "operator-cli/run.projects.test.ts",
    pattern: "an inaccessible controller",
  },
  {
    name: "missing controller status",
    file: "projects/main.ts",
    section: "list(paths:",
    before: 'controller = { status: "missing" };',
    after: 'controller = { status: "blocked", reason: "project_io_failed", detail: "broken" };',
    unit: "operator-cli/run.projects.test.ts",
    pattern: "lists controller status",
  },
  {
    name: "mismatched controller status",
    file: "projects/main.ts",
    section: "list(paths:",
    before: "observed.repositories.includes(project.repository)",
    after: "true",
    unit: "operator-cli/run.projects.test.ts",
    pattern: "lists controller status",
  },
  {
    name: "person instruction",
    file: "projects/main.ts",
    section: "remove(input:",
    before: "if (!input.personInstructed)",
    after: "if (false)",
    unit: "operator-cli/run.projects.test.ts",
    pattern: "removes only",
  },
  {
    name: "move open source",
    file: "device-state/projects.ts",
    section: "export function moveProject",
    before: "if (held)",
    after: "if (false)",
    unit: "operator-cli/run.projects.test.ts",
    pattern: "open sources block",
  },
  {
    name: "removal open source",
    file: "device-state/projects.ts",
    section: "export function removeProject",
    before: "if (held)",
    after: "if (false)",
    unit: "operator-cli/run.projects.test.ts",
    pattern: "open sources block",
  },
  {
    name: "changed identity",
    file: "device-state/projects.ts",
    section: "export function moveProject",
    before: "if (byPath && byPath.repository !== repository)",
    after: "if (false)",
    unit: "operator-cli/run.projects.test.ts",
    pattern: "moves only",
  },
  {
    name: "pending registration",
    file: "device-state/projects.ts",
    section: "export function registerProject",
    before: ".where(eq(projectRemovals.repository, project.repository))",
    after: ".where(eq(projectRemovals.repository, 'absent/identity'))",
    unit: "operator-cli/run.projects.test.ts",
    pattern: "keeps failed cleanup",
  },
  {
    name: "durable cleanup",
    file: "device-state/projects.ts",
    section: "export function removeProject",
    before:
      "db.insert(projectRemovals).values({ repository, removedAt: new Date().toISOString() }).run();",
    after: "",
    unit: "operator-cli/run.projects.test.ts",
    pattern: "keeps failed cleanup",
  },
  {
    name: "linked ancestor",
    file: "device-state/project-files.ts",
    section: "function checkDirectory",
    before: "!info.isDirectory() || info.isSymbolicLink()",
    after: "false",
    unit: "operator-cli/run.projects.test.ts",
    pattern: "keeps failed cleanup",
  },
  {
    name: "actual file deletion",
    file: "device-state/project-files.ts",
    section: "export function removeStateDirectory",
    before: "rmSync(directory, { recursive: true, force: true });",
    after: "",
    unit: "operator-cli/run.projects.test.ts",
    pattern: "removes only",
  },
  {
    name: "stale cleaner",
    file: "device-state/project-files.ts",
    section: "export function finishProjectRemoval",
    before: "if (!pending) return Ok(undefined);",
    after: "",
    unit: "operator-cli/run.projects.test.ts",
    pattern: "a stale cleanup",
  },
  {
    name: "cleanup writer reservation",
    file: "device-state/project-files.ts",
    section: "export function finishProjectRemoval",
    before: "transaction(client, true,",
    after: "transaction(client, false,",
    unit: "operator-cli/run.projects.test.ts",
    pattern: "project file cleanup holds",
  },
  {
    name: "registration directory recheck",
    file: "device-state/project-files.ts",
    section: "export function ensureProjectDirectory",
    before: "if (current?.checkout !== project.checkout)",
    after: "if (false)",
    unit: "device-state/project-files.test.ts",
    pattern: "directory creation rechecks",
  },
  {
    name: "pending cleanup migration guard",
    file: "device-state/migration-policy.ts",
    section: "const idleGuards",
    before: "applied: 3,",
    after: "applied: 99,",
    unit: "device-state/migration-policy.test.ts",
    pattern: "pending project file cleanup",
  },
])(
  "a deliberate break of project guard $name makes its behavior test fail",
  async (change) => {
    const file = `${root}/modules/${change.file}`;
    const original = await Bun.file(file).text();
    const offset = original.indexOf(change.section);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(original.slice(offset)).toContain(change.before);
    try {
      await Bun.write(
        file,
        original.slice(0, offset) + original.slice(offset).replace(change.before, change.after),
      );
      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          "test",
          `modules/${change.unit}`,
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
  30000,
);
