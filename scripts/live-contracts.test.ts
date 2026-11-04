import { afterAll, expect, test } from "bun:test";
// Bun has no temporary-directory, chmod, or recursive removal API.
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Environment } from "../modules/environment/main.ts";

const scriptPath = new URL("./live-contracts.ts", import.meta.url).pathname;
const sdkVersion = z
  .object({ version: z.string() })
  .parse(
    await Bun.file(
      Bun.resolveSync("@anthropic-ai/claude-agent-sdk/package.json", import.meta.dir),
    ).json(),
  ).version;
const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** A checkout with the given contract files and controlled tools that print a version. */
async function checkout(contracts: Record<string, string>, tools: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "operator-live-contracts-"));
  roots.push(root);
  for (const [file, body] of Object.entries(contracts))
    await Bun.write(`${root}/${file}`, `import { expect, test } from "bun:test";\n${body}\n`);
  for (const [tool, output] of Object.entries(tools)) {
    await Bun.write(`${root}/bin/${tool}`, `#!/bin/sh\necho ${JSON.stringify(output)}\n`);
    await chmod(`${root}/bin/${tool}`, 0o755);
  }
  return root;
}

async function run(root: string) {
  const child = Bun.spawn([process.execPath, scriptPath], {
    cwd: root,
    // The runner's own Bun stays reachable through its absolute path.
    env: Environment.child({ PATH: `${root}/bin` }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  const record = Bun.file(`${root}/docs/live-contracts.json`);
  return {
    exitCode,
    stderr,
    record: (await record.exists()) ? z.unknown().parse(await record.json()) : null,
  };
}

test("runs only contract files and records the versions they passed against", async () => {
  const root = await checkout(
    {
      "modules/b/main.contract.ts": 'test("b", () => expect(1).toBe(1));',
      "modules/a/main.contract.ts": 'test("a", () => expect(1).toBe(1));',
      "modules/a/main.test.ts": 'test("unit", () => expect(1).toBe(2));',
    },
    { herdr: "herdr 0.9.5", opencode: "2.2.5", claude: "2.1.311 (Claude Code)" },
  );
  const { exitCode, stderr, record } = await run(root);
  expect(exitCode).toBe(0);
  expect(stderr).toContain("2 pass");
  expect(record).toEqual({
    verifiedOn: new Date().toISOString().slice(0, 10),
    versions: {
      bun: Bun.version,
      herdr: "herdr 0.9.5",
      opencode: "2.2.5",
      claude: "2.1.311 (Claude Code)",
      "@anthropic-ai/claude-agent-sdk": sdkVersion,
    },
    files: ["modules/a/main.contract.ts", "modules/b/main.contract.ts"],
  });
});

test("a failed contract names the versions it ran against and records nothing", async () => {
  const root = await checkout(
    { "modules/a/main.contract.ts": 'test("herdr answers", () => expect(1).toBe(2));' },
    { herdr: "herdr 0.10.0" },
  );
  const { exitCode, stderr, record } = await run(root);
  expect(exitCode).toBe(1);
  expect(stderr).toContain("(fail) herdr answers");
  expect(stderr).toContain(
    `live-contracts: a contract failed against {"bun":"${Bun.version}","herdr":"herdr 0.10.0","opencode":null,"claude":null,`,
  );
  expect(record).toBeNull();
});

test("refuses a checkout without contract files", async () => {
  const root = await checkout({}, {});
  expect(await run(root)).toEqual({
    exitCode: 2,
    stderr: "live-contracts: no modules/**/*.contract.ts file to run.\n",
    record: null,
  });
});
