import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no recursive copy, temporary-directory, or symlink API.
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";

const source = Bun.fileURLToPath(new URL("../../", import.meta.url));
let root = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-profile-guards-"));
  for (const file of ["modules", "lib", "scripts", "cli.ts", "package.json", "bunfig.toml"])
    await cp(`${source}/${file}`, `${root}/${file}`, { recursive: true });
  await symlink(`${source}/node_modules`, `${root}/node_modules`);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test.each([
  {
    name: "explicit model",
    file: "agent-hosts/main.ts",
    before: "candidate.model === input.model || candidate.resolvedModel === input.model",
    after: "true",
    testFile: "operator-cli/run.profiles.test.ts",
    pattern: "refuses explicit launch choices",
  },
  {
    name: "explicit effort",
    file: "agent-hosts/main.ts",
    before: "!model.efforts.includes(input.reasoningEffort)",
    after: "false",
    testFile: "operator-cli/run.profiles.test.ts",
    pattern: "refuses explicit launch choices",
  },
  {
    name: "permission-free command",
    file: "agent-hosts/main.ts",
    before: 'args: ["--model", resolvedModel, "--effort", input.reasoningEffort]',
    after:
      'args: ["--model", resolvedModel, "--permission-mode", "bypassPermissions", "--effort", input.reasoningEffort]',
    testFile: "agent-hosts/main.test.ts",
    pattern: "constructs only model and effort",
  },
  {
    name: "profile ownership",
    file: "device-settings/selection.ts",
    before:
      "request.profile !== undefined && !Object.hasOwn(config.profiles ?? {}, request.profile)",
    after: "false",
    testFile: "device-settings/selection.test.ts",
    pattern: "refuses absent or inherited",
  },
  {
    name: "required host and model",
    file: "device-settings/selection.ts",
    before: "selected.host === undefined || selected.model === undefined",
    after: "false",
    testFile: "device-settings/selection.test.ts",
    pattern: "does not infer",
  },
  {
    name: "medium worker inheritance",
    file: "device-settings/selection.ts",
    before: ': "medium",',
    after: ': "high",',
    testFile: "device-settings/selection.test.ts",
    pattern: "inherits host and model",
  },
  {
    name: "catalog directory",
    file: "agent-hosts/catalog.ts",
    before: "parsed.location.directory !== cwd",
    after: "false",
    testFile: "agent-hosts/catalog.test.ts",
    pattern: "refuses unavailable",
  },
  {
    name: "enabled model",
    file: "agent-hosts/catalog.ts",
    before: ".filter((model) => model.enabled)",
    after: ".filter(() => true)",
    testFile: "agent-hosts/catalog.test.ts",
    pattern: "uses directory-scoped",
  },
  {
    name: "plan and apply validation",
    file: "device-settings/validation.ts",
    before: 'if (result.tag === "Err") return result.error;',
    after: "if (false) return null;",
    testFile: "operator-cli/run.profiles.test.ts",
    pattern: "revalidates actual host support",
  },
  {
    name: "protected profile write",
    file: "device-settings/change.ts",
    before: "if (await externallyManaged(request.paths)) return externallyOwned;",
    after: "",
    testFile: "operator-cli/run.profiles.test.ts",
    pattern: "protects external configuration before",
  },
  {
    name: "unsafe profile names",
    file: "device-settings/schema.ts",
    before:
      'context.addIssue({ code: "custom", message: "Unsupported profile name: __proto__." });',
    after: "void context;",
    testFile: "device-settings/schema.test.ts",
    pattern: "accepts extensible profiles",
  },
])(
  "a deliberate break of profile guard $name makes its behavior test fail",
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
