import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no recursive copy, temporary-directory, or symlink API.
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";

const source = Bun.fileURLToPath(new URL("../../", import.meta.url));
let root = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-compatibility-guards-"));
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
    name: "missing-state refusal",
    file: "device-state/compatibility.ts",
    before: "return firstRegistration",
    after: "return true",
    pattern: "only explicit registration can pass",
    testFile: "operator-cli/run.compatibility.test.ts",
  },
  {
    name: "backup defects",
    file: "device-state/backups.ts",
    before: 'if (result.tag === "Defect") return result.map(() => []);',
    after: "",
    pattern: "unexpected backup discovery defect",
    testFile: "operator-cli/run.compatibility.test.ts",
  },
  {
    name: "shared startup",
    file: "operator-cli/run.ts",
    before: 'if (compatible.tag !== "Ok")',
    after: "if (false)",
    pattern: "startup refuses conflicting-hash",
    testFile: "operator-cli/run.compatibility.test.ts",
  },
  {
    name: "automatic upgrade",
    file: "device-state/compatibility.ts",
    before: "const upgraded = upgrade(paths);",
    after: "const upgraded = Ok(false);",
    pattern: "startup upgrades matching older",
    testFile: "operator-cli/run.compatibility.test.ts",
  },
  {
    name: "protected snapshot",
    file: "device-state/compatibility.ts",
    before: "transaction(client, true,",
    after: "transaction(client, false,",
    pattern: "the protected delete snapshot",
    testFile: "operator-cli/run.compatibility.test.ts",
  },
  {
    name: "concurrent recheck",
    file: "device-state/compatibility.ts",
    before: "if (recorded.length === shipped.length) return Ok(false);",
    after: "if (false) return Ok(false);",
    pattern: "simultaneous public starts",
    testFile: "operator-cli/run.compatibility.test.ts",
  },
  {
    name: "backup history",
    file: "device-state/backups.ts",
    before: "if (JSON.stringify(backupHistory(backup)) !== JSON.stringify(history))",
    after: "if (false)",
    pattern: "a snapshot must match",
    testFile: "device-state/backups.test.ts",
  },
  {
    name: "backup hash",
    file: "device-state/backups.ts",
    before: "!==\n            receipt.hash",
    after: "===\n            receipt.hash",
    pattern: "verification rejects changed",
    testFile: "device-state/backups.test.ts",
  },
  {
    name: "backup retention",
    file: "device-state/backups.ts",
    before: ".slice(3)",
    after: ".slice(2)",
    pattern: "retention keeps three",
    testFile: "operator-cli/run.compatibility.test.ts",
  },
  {
    name: "active device work",
    file: "device-state/migration-policy.ts",
    before: "applied >= 2 &&",
    after: "false &&",
    pattern: "device-wide active assignments",
    testFile: "operator-cli/run.compatibility.test.ts",
  },
  {
    name: "declared held records",
    file: "device-state/migration-policy.ts",
    before: "if (client.query(query).get())",
    after: "if (false)",
    pattern: "device-wide active assignments",
    testFile: "operator-cli/run.compatibility.test.ts",
  },
  {
    name: "unsupported migration policy",
    file: "device-state/migration-policy.ts",
    before: "if (!queries)",
    after: "if (false)",
    pattern: "each fixed migration declares",
    testFile: "device-state/migration-policy.test.ts",
  },
  {
    name: "history timestamps",
    file: "device-state/database.ts",
    before: "shipped[index]?.folderMillis !== migration.created_at",
    after: "false",
    pattern: "startup refuses conflicting-time",
    testFile: "operator-cli/run.compatibility.test.ts",
  },
  {
    name: "unsupported database paths",
    file: "device-state/creation.ts",
    before: "if (!lstatSync(file).isFile())",
    after: "if (false)",
    pattern: "startup refuses an unsupported",
    testFile: "operator-cli/run.compatibility.test.ts",
  },
])(
  "a deliberate break of $name fails its behavior test",
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
