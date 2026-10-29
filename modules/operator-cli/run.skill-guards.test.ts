import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no recursive copy, temporary-directory, or symlink API.
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";

const source = Bun.fileURLToPath(new URL("../../", import.meta.url));
let root = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-skill-guards-"));
  for (const file of [
    "modules",
    "lib",
    "scripts",
    "skills",
    "cli.ts",
    "package.json",
    "bunfig.toml",
  ])
    await cp(`${source}/${file}`, `${root}/${file}`, { recursive: true });
  await symlink(`${source}/node_modules`, `${root}/node_modules`);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test.each([
  {
    name: "writer-scoped content inspection",
    file: "owned-skills/install.ts",
    before: "await mkdir(request.paths.stateRoot, { recursive: true });",
    after:
      'const early = await inspect(request, await ledger(request.paths.ownedSkills)); if (!("copies" in early)) return early; await mkdir(request.paths.stateRoot, { recursive: true });',
    testFile: "operator-cli/run.skills.test.ts",
    pattern: "an install waits for the owned writer",
  },
  {
    name: "prototype filename identity",
    file: "owned-skills/content.ts",
    before: "Object.setPrototypeOf(result, null);",
    after: "",
    testFile: "operator-cli/run.skills.test.ts",
    pattern: "prototype-named",
  },
  {
    name: "prototype filename ledger",
    file: "owned-skills/install.ts",
    before: "entries: z.record(z.string(), contentsSchema)",
    after: "entries: z.record(z.string(), z.record(z.string(), z.string()))",
    testFile: "owned-skills/install.test.ts",
    pattern: "the ledger preserves prototype-named assets",
  },
  {
    name: "complete identity",
    file: "owned-skills/content.ts",
    before: "Object.keys(left).length === Object.keys(right).length &&",
    after: "",
    testFile: "owned-skills/content.test.ts",
    pattern: "only an exact ledger identity",
  },
  {
    name: "managed update proof",
    file: "owned-skills/content.ts",
    before: "managed !== null && same(current, managed)",
    after: "true",
    testFile: "operator-cli/run.skills.test.ts",
    pattern: "refuses modified managed content",
  },
  {
    name: "matching copy",
    file: "owned-skills/install.ts",
    before: 'if (copy.action === "matching") return true;',
    after: "",
    testFile: "operator-cli/run.skills.test.ts",
    pattern: "matching copies and their ledger",
  },
  {
    name: "old-name ownership",
    file: "owned-skills/content.ts",
    before: 'return "conflict";',
    after: 'return released === null ? "remove" : "update";',
    testFile: "operator-cli/run.skills.test.ts",
    pattern: "an unrelated retired role skill",
  },
  {
    name: "old-name retirement",
    file: "owned-skills/install.ts",
    before: 'const retired = ["operator", "operative"];',
    after: "const retired: string[] = [];",
    testFile: "operator-cli/run.skills.test.ts",
    pattern: "removes unchanged old-name managed roles",
  },
  {
    name: "link protection",
    file: "owned-skills/content.ts",
    before: "entry.isSymbolicLink() || !writableMode",
    after: "!writableMode",
    testFile: "owned-skills/content.test.ts",
    pattern: "copy mode rejects links",
  },
  {
    name: "read-only ancestors",
    file: "owned-skills/content.ts",
    before: "entry.isSymbolicLink() || !writableMode(entry.mode)",
    after: "entry.isSymbolicLink()",
    testFile: "operator-cli/run.skills.test.ts",
    pattern: "a read-only skill folder",
  },
  {
    name: "read-only folder above an absent root",
    file: "owned-skills/content.ts",
    before: "if (entry !== null) return writableMode(entry.mode);",
    after: "if (entry !== null) return true;",
    testFile: "owned-skills/content.test.ts",
    pattern: "an absent root under a read-only linked folder",
  },
  {
    name: "system links above the root",
    file: "owned-skills/content.ts",
    before: "if (current === root) {",
    after: "if (false) {",
    testFile: "owned-skills/content.test.ts",
    pattern: "allows links above the managed root",
  },
  {
    name: "read-only supporting assets",
    file: "owned-skills/install.ts",
    before: '["", ...Object.keys(current ?? {})]',
    after: '[""]',
    testFile: "owned-skills/install.test.ts",
    pattern: "a read-only supporting asset",
  },
  {
    name: "Nix check-only",
    file: "owned-skills/install.ts",
    before: 'requested || source.startsWith("/nix/store/")',
    after: "requested",
    testFile: "owned-skills/install.test.ts",
    pattern: "Nix always checks",
  },
  {
    name: "check-only writes",
    file: "owned-skills/install.ts",
    before: "if (request.check) {",
    after: "if (false) {",
    testFile: "operator-cli/run.skills.test.ts",
    pattern: "check mode follows complete skill links",
  },
  {
    name: "check-only contents",
    file: "owned-skills/install.ts",
    before: "copy.released !== null && !same(copy.current, copy.released)",
    after: "false",
    testFile: "operator-cli/run.skills.test.ts",
    pattern: "missing check-only contents",
  },
  {
    name: "ledger version",
    file: "owned-skills/install.ts",
    before: "version: z.literal(1)",
    after: "version: z.number()",
    testFile: "operator-cli/run.skills.test.ts",
    pattern: "an invalid ledger",
  },
  {
    name: "defect qualification",
    file: "owned-skills/main.ts",
    before: "return defect(cause);",
    after: 'return {reason:"skills_io_failed" as const,detail:String(cause)};',
    testFile: "owned-skills/main.test.ts",
    pattern: "preserves programming defects",
  },
])(
  "a deliberate break of owned-skill guard $name makes its behavior test fail",
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
