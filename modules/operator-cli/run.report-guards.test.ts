import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no recursive copy, temporary-directory, or symlink API.
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";

const source = Bun.fileURLToPath(new URL("../../", import.meta.url));
let root = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-report-guards-"));
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

const accepted = "report completes only through SuperAgent acceptance";
const returned = "returned work resumes";
const cleanup = "acceptance keeps a worktree with unlanded work";

test.each([
  {
    name: "submission is not completion",
    file: "work-sources/report-machine.ts",
    before:
      'return Ok({ assignmentState: "reported", report: { insert: (latest?.number ?? 0) + 1 } });',
    after:
      'return Ok({ assignmentState: "completed", report: { insert: (latest?.number ?? 0) + 1 } });',
    pattern: accepted,
  },
  {
    name: "no self acceptance",
    file: "work-sources/report-machine.ts",
    before: '(facts.command === "accept" || facts.command === "return") && selfDecision(facts)',
    after: "false",
    pattern: accepted,
  },
  {
    name: "accepted launch ends",
    file: "work-sources/report-machine.ts",
    before: 'finishLaunch: launch?.state === "running" ? launch.id : undefined',
    after: "finishLaunch: undefined",
    pattern: accepted,
  },
  {
    name: "worker pane on its own server",
    file: "device-state/reports.ts",
    before: "eq(launches.herdrSocket, target.socket),",
    after: "",
    pattern: accepted,
  },
  {
    name: "review before replacement",
    file: "work-sources/assignment-machine.ts",
    before: 'assignment.state === "reported" && report?.decision === null',
    after: "false",
    pattern: returned,
  },
  {
    name: "returned report replacement",
    file: "device-state/launches.ts",
    before: '      (assignment === "reported" && returned)) &&',
    after: "      false) &&",
    pattern: returned,
  },
  {
    name: "copied supporting files",
    file: "report-assignments/main.ts",
    before: "await copyFile(file,",
    after: "void (file,",
    pattern: returned,
  },
  {
    name: "unlanded work stays",
    file: "worker-dispatch/worktree-cleanup.ts",
    before: "if (reasons.length > 0)",
    after: "if (false)",
    pattern: cleanup,
  },
  {
    name: "recorded branch tip inspection",
    file: "worker-dispatch/worktree-cleanup.ts",
    before: "await branchExists(worktree, branch)",
    after: "false",
    testFile: "worker-dispatch/worktree-cleanup.test.ts",
    pattern: "a branch commit while HEAD is detached elsewhere",
  },
  {
    name: "visible failed cleanup",
    file: "work-sources/assignment-machine.ts",
    before: '(report.cleanup === "failed" || report.cleanup === "pending")',
    after: "false",
    pattern: cleanup,
  },
  {
    name: "pane closure on the launch's server",
    file: "report-assignments/main.ts",
    before: "if (caller().socket !== launch.herdrSocket)",
    after: "if (false)",
    pattern: cleanup,
  },
])(
  "a deliberate break of report guard $name makes its behavior test fail",
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
          `modules/${"testFile" in change ? change.testFile : "operator-cli/run.reports.test.ts"}`,
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
