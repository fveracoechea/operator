import { afterAll, expect, test } from "bun:test";
import { Environment } from "../environment/main.ts";
// Bun has no temporary-directory, directory-listing or recursive-removal API.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("the public CLI refuses ambiguous stdin before creating or accessing device state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cli-interface-"));
  roots.push(root);
  const entry = new URL("./main.ts", import.meta.url).pathname;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
const { OperatorCli } = await import(${JSON.stringify(entry)});
await OperatorCli.main(["dispatch", "--kind", "answer", "--brief", "-", "--intent-file", "-", "--json"]);
`,
    ],
    {
      cwd: root,
      env: Environment.child({
        HOME: root,
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_STATE_HOME: path.join(root, "state"),
      }),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code).toBe(2);
  expect(JSON.parse(stdout)).toMatchObject({
    operation: "dispatch",
    outcome: "invalid",
    reason: "invalid_source_plan",
    state: { inputValid: false },
  });
  expect(stderr).toContain("The brief and intent cannot both read stdin.");
  expect(await readdir(root)).not.toContain("state");
  expect(await readdir(root)).not.toContain("config");
});
