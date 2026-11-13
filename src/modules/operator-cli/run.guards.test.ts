import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no recursive copy, temporary-directory, or symlink API.
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";

const source = new URL("../../../", import.meta.url).pathname;
let root = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-registration-guards-"));
  for (const file of ["src", "tools", "package.json", "bunfig.toml"])
    await cp(`${source}/${file}`, `${root}/${file}`, { recursive: true });
  await symlink(`${source}/node_modules`, `${root}/node_modules`);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test.each([
  {
    name: "next metadata transport",
    file: "src/modules/operator-cli/output.ts",
    before: "next: context.next,",
    after: "next: undefined,",
    testFile: "src/modules/operator-cli/run.sources.test.ts",
    pattern: "every refusal carries reason",
  },
  {
    name: "checked-state transport",
    file: "src/modules/operator-cli/output.ts",
    before: "state: context.state,",
    after: "state: undefined,",
    testFile: "src/modules/operator-cli/run.sources.test.ts",
    pattern: "every refusal carries reason",
  },
  {
    name: "three-line refusal output",
    file: "src/modules/operator-cli/output.ts",
    before: 'return text.replaceAll(/[\\r\\n\\u2028\\u2029]+/g, " ");',
    after: "return text;",
    testFile: "src/modules/operator-cli/run.result-context.test.ts",
    pattern: "CLI renders a refusal next step",
  },
  {
    name: "row command agreement",
    file: "src/modules/operator-cli/next.ts",
    before: "described.command = next.command;",
    after: 'described.command = "operator incorrect";',
    testFile: "src/modules/operator-cli/run.sources.test.ts",
    pattern: "every next-action row carries next",
  },
  {
    name: "immediate writer",
    file: "src/modules/device-state/database.ts",
    before: 'client.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");',
    after: 'client.exec("BEGIN");',
    testFile: "src/modules/device-state/database.test.ts",
    pattern: "a write transaction reserves",
  },
  {
    name: "non-replacing publication",
    file: "src/modules/device-state/creation.ts",
    before: "linkSync(temporary, paths.database);",
    after: 'require("node:fs").renameSync(temporary, paths.database);',
    testFile: "src/modules/device-state/creation.test.ts",
    pattern: "publishes one complete migrated database",
  },
  {
    name: "legacy presence",
    file: "src/modules/projects/checkout.ts",
    before: "/.operator`)",
    after: "/.not-legacy`)",
    testFile: "src/modules/operator-cli/run.projects.test.ts",
    pattern: "refuses legacy local state",
  },
  {
    name: "linked controller",
    file: "src/modules/projects/checkout.ts",
    before: "(await realpath(dir.text)) !== (await realpath(common.text))",
    after: "false",
    testFile: "src/modules/operator-cli/run.projects.test.ts",
    pattern: "refuses bare repositories and linked",
  },
  {
    name: "canonical identity",
    file: "src/modules/projects/identity.ts",
    before: "return value.toLowerCase();",
    after: "return value;",
    testFile: "src/modules/projects/identity.test.ts",
    pattern: "canonicalizes a GitHub remote",
  },
  {
    name: "explicit matching choice",
    file: "src/modules/projects/identity.ts",
    before: "identity === null || !repositories.includes(identity)",
    after: "identity === null",
    testFile: "src/modules/projects/identity.test.ts",
    pattern: "validates explicit identities",
  },
  {
    name: "controller identity",
    file: "src/modules/device-state/projects.ts",
    before: "byPath && byPath.repository !== project.repository",
    after: "false",
    testFile: "src/modules/device-state/projects.test.ts",
    pattern: "uses Drizzle constraints",
  },
  {
    name: "alternate clone",
    file: "src/modules/device-state/projects.ts",
    before: "byIdentity && byIdentity.checkout !== project.checkout",
    after: "false",
    testFile: "src/modules/device-state/projects.test.ts",
    pattern: "uses Drizzle constraints",
  },
  {
    name: "history hash",
    file: "src/modules/device-state/database.ts",
    before: "shipped[index]?.hash !== migration.hash",
    after: "false",
    testFile: "src/modules/operator-cli/run.projects.test.ts",
    pattern: "refuses conflicting device state",
  },
  {
    name: "Err and Defect rollback",
    file: "src/modules/device-state/database.ts",
    before: 'if (result.tag === "Ok") client.exec("COMMIT");',
    after: 'client.exec("COMMIT");',
    testFile: "src/modules/device-state/database.test.ts",
    pattern: "commits only Ok",
  },
  {
    name: "read snapshot",
    file: "src/modules/device-state/database.ts",
    before: 'if (result.tag === "Ok") client.exec("COMMIT");',
    after: 'if (result.tag === "Ok" && write) client.exec("COMMIT");',
    extraBefore: 'client.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");',
    extraAfter: 'if (write) client.exec("BEGIN IMMEDIATE");',
    testFile: "src/modules/device-state/database.test.ts",
    pattern: "reads a consistent snapshot",
  },
  {
    name: "full synchronization",
    file: "src/modules/device-state/database.ts",
    before: "PRAGMA synchronous = FULL",
    after: "PRAGMA synchronous = OFF",
    testFile: "src/modules/device-state/database.test.ts",
    pattern: "opens only existing files",
  },
])(
  "a deliberate break of $name makes its behavior test fail",
  async (change) => {
    const file = `${root}/${change.file}`;
    const original = await Bun.file(file).text();
    expect(original).toContain(change.before);
    let broken = original.replace(change.before, change.after);
    if (change.extraBefore !== undefined && change.extraAfter !== undefined) {
      expect(broken).toContain(change.extraBefore);
      broken = broken.replace(change.extraBefore, change.extraAfter);
    }
    try {
      await Bun.write(file, broken);
      const child = Bun.spawn(
        [process.execPath, "run", "test", change.testFile, "--test-name-pattern", change.pattern],
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
