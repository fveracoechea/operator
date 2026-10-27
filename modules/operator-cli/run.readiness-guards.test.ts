import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no recursive copy, temporary-directory, or symlink API.
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";

const source = Bun.fileURLToPath(new URL("../../", import.meta.url));
let root = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-readiness-guards-"));
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
    name: "installer version",
    file: "upstream-skills/main.ts",
    before: 'const installerVersion = "1.7.4";',
    after: 'const installerVersion = "latest";',
    testFile: "operator-cli/run.upstream.test.ts",
    pattern: "delegates an exact installer",
  },
  {
    name: "full commit",
    file: "upstream-skills/catalog.ts",
    before: "regex(/^[a-f0-9]{40}$/)",
    after: "regex(/^[a-z0-9]+$/)",
    testFile: "operator-cli/run.upstream.test.ts",
    pattern: "a non-full upstream revision",
  },
  {
    name: "global scope",
    file: "upstream-skills/main.ts",
    before: '"--global",',
    after: "",
    testFile: "operator-cli/run.upstream.test.ts",
    pattern: "delegates an exact installer",
  },
  {
    name: "explicit hosts",
    file: "upstream-skills/main.ts",
    before: "...hosts,",
    after: '"*",',
    testFile: "operator-cli/run.upstream.test.ts",
    pattern: "delegates an exact installer",
  },
  {
    name: "owned exclusion",
    file: "upstream-skills/catalog.ts",
    before: ".filter((name) => !excluded.has(name))",
    after: "",
    testFile: "operator-cli/run.upstream.test.ts",
    pattern: "delegates an exact installer",
  },
  {
    name: "no extra exclusions",
    file: "upstream-skills/catalog.ts",
    before: ".filter((name) => !excluded.has(name))",
    after: '.filter((name) => !excluded.has(name) && name !== "cursor")',
    testFile: "operator-cli/run.upstream.test.ts",
    pattern: "delegates an exact installer",
  },
  {
    name: "nonempty roster",
    file: "upstream-skills/main.ts",
    before: "owned.length === 0 || skills.length === 0",
    after: "false",
    testFile: "operator-cli/run.upstream.test.ts",
    pattern: "owned-only",
  },
  {
    name: "installer confirmation",
    file: "upstream-skills/main.ts",
    before: "!installed(result.stdout, skills)",
    after: "false",
    testFile: "operator-cli/run.upstream.test.ts",
    pattern: "partial-answer",
  },
  {
    name: "authentication",
    file: "readiness/main.ts",
    before: 'auth.status !== "completed" || auth.exitCode !== 0',
    after: "false",
    testFile: "operator-cli/run.readiness.test.ts",
    pattern: "reports failed authentication",
  },
  {
    name: "configured host availability",
    file: "readiness/main.ts",
    before: "Bun.which(tool, { PATH: Environment.read().PATH }) === null",
    after: "false",
    testFile: "operator-cli/run.readiness.test.ts",
    pattern: "reports failed authentication",
  },
  {
    name: "required executables",
    file: "readiness/main.ts",
    before: 'for (const tool of ["gh", "herdr"] as const)',
    after: "for (const tool of [] as string[])",
    testFile: "operator-cli/run.readiness.test.ts",
    pattern: "reports missing tools",
  },
  {
    name: "global operator command",
    file: "global-launcher/main.ts",
    before: 'if (found === null)\n    return [{ reason: "executable_missing"',
    after: 'if (found === "never")\n    return [{ reason: "executable_missing"',
    testFile: "operator-cli/run.readiness.test.ts",
    pattern: "reports missing tools",
  },
  {
    name: "complete owned contents",
    file: "readiness/main.ts",
    before: 'if (owned.tag === "Err")',
    after: "if (false)",
    testFile: "operator-cli/run.readiness.test.ts",
    pattern: "reports failed authentication",
  },
  {
    name: "required upstream presence",
    file: "upstream-skills/main.ts",
    before: 'const required = ["code-review"];',
    after: "const required: string[] = [];",
    testFile: "operator-cli/run.readiness.test.ts",
    pattern: "reports failed authentication",
  },
  {
    name: "no host launch",
    file: "readiness/main.ts",
    before: 'const tool = host === "opencode" ? "opencode" : "claude";',
    after:
      'const tool = host === "opencode" ? "opencode" : "claude"; await ToolInvocation.run({tool,args:["--probe"],timeoutMs:1000});',
    testFile: "operator-cli/run.readiness.test.ts",
    pattern: "static readiness for",
  },
  {
    name: "no retained readiness state",
    file: "readiness/main.ts",
    before: "const host = await checkHost(paths);",
    after: `await Bun.write(\`\${paths.stateRoot}/readiness.json\`, "ready", {createPath:true}); const host = await checkHost(paths);`,
    testFile: "operator-cli/run.readiness.test.ts",
    pattern: "reports missing tools",
  },
  {
    name: "defect qualification",
    file: "upstream-skills/main.ts",
    before: "return defect(cause);",
    after: 'return {reason:"upstream_io_failed" as const,detail:String(cause)};',
    testFile: "upstream-skills/main.test.ts",
    pattern: "unexpected programming defects",
  },
  {
    name: "direct test tool boundary",
    file: "readiness/main.test.ts",
    before: 'spyOn(ToolInvocation, "run").mockResolvedValue(',
    after: "({mockRestore(){}}); void (",
    testFile: "readiness/main.isolation.test.ts",
    pattern: "direct readiness tests cannot request ambient",
  },
])(
  "a deliberate break of readiness guard $name makes its behavior test fail",
  async (change) => {
    const file = `${root}/modules/${change.file}`;
    const original = await Bun.file(file).text();
    expect(original).toContain(change.before);
    try {
      await Bun.write(file, original.replace(change.before, change.after));
      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          "test",
          `modules/${change.testFile}`,
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

test("a deliberate widening of the readiness failure contract fails typechecking", async () => {
  const file = `${root}/modules/readiness/main.ts`;
  const original = await Bun.file(file).text();
  const before = 'reason: "host_unconfigured" | "github_auth_failed" | "upstream_skills_missing";';
  expect(original).toContain(before);
  try {
    await Bun.write(file, original.replace(before, "reason: string;"));
    const child = Bun.spawn([process.execPath, "run", "typecheck"], {
      cwd: root,
      env: Environment.child({ BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, `${stdout}${stderr}`).toBe(1);
    expect(`${stdout}${stderr}`).toContain("modules/readiness/main.test.ts");
    expect(`${stdout}${stderr}`).toContain("TS2554");
  } finally {
    await Bun.write(file, original);
  }
}, 30000);
