import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no recursive copy, temporary-directory, or symlink API.
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";

const source = Bun.fileURLToPath(new URL("../../../", import.meta.url));
let root = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-source-guards-"));
  for (const file of [
    "src",

    "tools",
    "skills",

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
    name: "unique assignment keys",
    file: "work-sources/plan.ts",
    before: "keys.size !== plan.assignments.length",
    after: "false",
    testFile: "operator-cli/run.sources.test.ts",
    pattern: "duplicate key",
  },
  {
    name: "acyclic dependencies",
    file: "work-sources/plan.ts",
    before: "Dependencies must form an acyclic plan within this source.",
    after: "broken",
    testFile: "work-sources/plan.test.ts",
    pattern: "rejects invalid dependency graphs",
  },
  {
    name: "assignment kind requirement",
    file: "work-sources/plan.ts",
    before: "kind: z.enum(WorkerKinds.names()),",
    after: 'kind: z.enum(WorkerKinds.names()).default("research"),',
    testFile: "operator-cli/run.dispatch.test.ts",
    pattern: "a plan assignment without a kind",
  },
  {
    name: "kind-derived completion",
    file: "work-sources/plan.ts",
    before: "completion: kind.completion,",
    after: 'completion: "pr",',
    testFile: "operator-cli/run.dispatch.test.ts",
    pattern: "dispatch with a kind fixes the completion type",
  },
  {
    name: "plain dispatch kind restriction",
    file: "work-sources/assignment-machine.ts",
    before: "dispatchable === false",
    after: "false",
    testFile: "operator-cli/run.dispatch.test.ts",
    pattern: "cannot be plainly dispatched",
  },
  {
    name: "kind snapshot persistence",
    file: "worker-dispatch/main.ts",
    before: "kind: settings.kind === null ? null : JSON.stringify(settings.kind),",
    after: "kind: null,",
    testFile: "operator-cli/run.dispatch.test.ts",
    pattern: "a launch keeps its kind snapshot",
  },
  {
    name: "branch validity",
    file: "work-sources/plan.ts",
    before: "refine(validBranch,",
    after: "refine(() => true,",
    testFile: "operator-cli/run.sources.test.ts",
    pattern: "invalid branch",
  },
  {
    name: "reserved HEAD branch",
    file: "work-sources/plan.ts",
    before: 'value === "HEAD"',
    after: "false",
    testFile: "operator-cli/run.sources.test.ts",
    pattern: "branch inputs match Git",
  },
  {
    name: "source lifecycle consistency",
    file: "work-sources/snapshot.ts",
    before: "if (!consistent || !validLifecycle)",
    after: "if (!consistent)",
    testFile: "operator-cli/run.sources.test.ts",
    pattern: "inconsistent",
  },
  {
    name: "selected profile existence",
    file: "work-sources/main.ts",
    before: "if (missing)",
    after: "if (false)",
    testFile: "operator-cli/run.sources.test.ts",
    pattern: "accepts selected profiles",
  },
  {
    name: "one open parent",
    file: "device-state/sources.ts",
    before: "if (existing)",
    after: "if (false)",
    testFile: "operator-cli/run.sources.test.ts",
    pattern: "rejects a second open parent",
  },
  {
    name: "project source scope",
    file: "device-state/sources.ts",
    before: "and(eq(sources.repository, repository), eq(sources.id, sourceId))",
    after: "eq(sources.id, sourceId)",
    testFile: "operator-cli/run.sources.test.ts",
    pattern: "empty sources end",
  },
  {
    name: "report acceptance",
    file: "work-sources/assignment-machine.ts",
    before: 'dependency.state !== "completed"',
    after: 'dependency.state !== "completed" && dependency.state !== "reported"',
    testFile: "operator-cli/run.sources.test.ts",
    pattern: "next uses completion-type-specific",
  },
  {
    name: "PR-open dependency",
    file: "work-sources/assignment-machine.ts",
    before: 'dependency.state !== "pr-open" && dependency.state !== "merged"',
    after: 'dependency.state !== "merged"',
    testFile: "operator-cli/run.sources.test.ts",
    pattern: "next uses completion-type-specific",
  },
  {
    name: "empty source completion",
    file: "work-sources/source-machine.ts",
    before: 'state: "finished",',
    after: 'state: "open",',
    testFile: "operator-cli/run.sources.test.ts",
    pattern: "empty sources end",
  },
  {
    name: "snapshot consistency",
    file: "work-sources/snapshot.ts",
    before: "if (!consistent || !validLifecycle)",
    after: "if (false)",
    testFile: "operator-cli/run.sources.test.ts",
    pattern: "corrupt extra-row",
  },
  {
    name: "no tracker operations",
    file: "work-sources/main.ts",
    before: "const id = crypto.randomUUID();",
    // A busy machine can take seconds to start the controlled gh, and a timeout stops it before it
    // records the call. With a limit above the behavior test's own, the start time never decides.
    after:
      'await import("../tool-invocation/main.ts").then(({ToolInvocation}) => ToolInvocation.run({tool:"gh",args:["issue","list"],timeoutMs:60000})); const id = crypto.randomUUID();',
    testFile: "operator-cli/run.sources.test.ts",
    pattern: "registers a supplied mixed plan",
  },
])(
  "a deliberate break of source guard $name makes its behavior test fail",
  async (change) => {
    const file = `${root}/src/modules/${change.file}`;
    const original = await Bun.file(file).text();
    expect(original).toContain(change.before);
    try {
      let changed = original.replace(change.before, change.after);
      if (change.name === "acyclic dependencies")
        changed = original.replace(
          'context.addIssue({\n          code: "custom",\n          message: "Dependencies must form an acyclic plan within this source.",\n        });',
          "",
        );
      if (change.name === "no tracker operations")
        changed = original
          .replace(
            "Projects.current(input).flatMap(({ data: project }) => {",
            "Projects.current(input).flatMap(async ({ data: project }) => {",
          )
          .replace(change.before, change.after);
      await Bun.write(file, changed);
      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          "test",
          `src/modules/${change.testFile}`,
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
