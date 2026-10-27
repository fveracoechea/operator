import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no recursive copy, temporary-directory, or symlink API.
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";

const source = Bun.fileURLToPath(new URL("../../", import.meta.url));
let root = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-launcher-guards-"));
  for (const file of [
    "modules",
    "lib",
    "scripts",
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
    name: "built release",
    file: "global-launcher/plan.ts",
    before: "if (!facts.built)",
    after: "if (false)",
    testFile: "global-launcher/plan.test.ts",
    pattern: "only the built release",
  },
  {
    name: "Bun's global package location",
    file: "global-launcher/plan.ts",
    before: "facts.packageRoot !== expected",
    after: "false",
    testFile: "global-launcher/plan.test.ts",
    pattern: "only the built release",
  },
  {
    name: "exact installed version",
    file: "global-launcher/plan.ts",
    before: "if (facts.specifier !== `npm:",
    after: "if (false && `npm:",
    testFile: "global-launcher/plan.test.ts",
    pattern: "only the built release",
  },
  {
    name: "existing command content",
    file: "global-launcher/plan.ts",
    before: "facts.destination.text === text",
    after: "true",
    testFile: "global-launcher/plan.test.ts",
    pattern: "matching content needs no write",
  },
  {
    name: "version-free launcher",
    file: "global-launcher/plan.ts",
    before: `globalRoot}\${ENTRY}\`)} "$@"`,
    after: `globalRoot}/1.2.3\${ENTRY}\`)} "$@"`,
    testFile: "global-launcher/plan.test.ts",
    pattern: "an exact global JSR install gets a launcher",
  },
  {
    name: "refusal before write",
    file: "global-launcher/main.ts",
    before: 'if (decision.action === "refuse")',
    after: "if (false)",
    testFile: "operator-cli/run.launcher.test.ts",
    pattern: "a source checkout gets no launcher",
  },
  {
    name: "launcher target text",
    file: "global-launcher/plan.ts",
    before: "return expected === text ? target : null;",
    after: "return target;",
    testFile: "global-launcher/plan.test.ts",
    pattern: "only the exact launcher text names a target",
  },
  {
    name: "Nix launcher text",
    file: "global-launcher/plan.ts",
    before:
      "found[1] === undefined ? launcherText(root) : nixLauncherText(root, unquote(found[1]))",
    after: "launcherText(root)",
    testFile: "global-launcher/plan.test.ts",
    pattern: "the Nix launcher runs the package's own Bun",
  },
  {
    name: "full source commit pin",
    file: "global-launcher/plan.ts",
    before: "/#[0-9a-f]{40}$/.test(specifier)",
    after: 'specifier.includes("#")',
    testFile: "global-launcher/plan.test.ts",
    pattern: "only an exact JSR version or a full source commit is pinned",
  },
  {
    name: "global command runs this release",
    file: "global-launcher/main.ts",
    before: "if (!reached.some((path) => path !== null && entries.includes(path)))",
    after: "if (false)",
    testFile: "operator-cli/run.readiness.test.ts",
    pattern: "on PATH is a mismatch",
  },
  {
    name: "source commit identity",
    file: "operator-release/manifest.ts",
    before: "/^[0-9a-f]{40}$/.test(tag)",
    after: "tag.length > 0",
    testFile: "operator-release/manifest.test.ts",
    pattern: "a source installation reports only the full commit",
  },
])(
  "a deliberate break of launcher guard $name makes its behavior test fail",
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
  60000,
);
