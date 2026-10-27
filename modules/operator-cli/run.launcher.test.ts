import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory, directory creation, chmod, or recursive removal API.
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { registerTestDevice } from "../../scripts/device-fixture.ts";

let root = "";
let databaseBefore: ArrayBuffer;
const cli = Bun.fileURLToPath(new URL("../../cli.ts", import.meta.url));
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-launcher-"));
  databaseBefore = await registerTestDevice(root);
  await mkdir(`${root}/bun`);
});
afterEach(async () => {
  try {
    expect(await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(
      databaseBefore,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A controlled Bun that reports isolated global folders and records every request. */
async function controlledBun(answer: string) {
  await Bun.write(
    `${root}/tools/bun`,
    `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(`${root}/bun-requests`)}, JSON.stringify(process.argv.slice(2)) + "\\n");
${answer}`,
    { createPath: true },
  );
  await chmod(`${root}/tools/bun`, 0o755);
}

async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: root,
    env: Environment.child({
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      PATH: `${root}/tools`,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function globalFiles() {
  return Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: `${root}/bun`, dot: true }));
}

test("a source checkout gets no launcher and leaves Bun's global folders unchanged", async () => {
  await Bun.write(
    `${root}/bun/install/global/package.json`,
    '{"dependencies":{"@fveracoechea/operator":"npm:@jsr/fveracoechea__operator@0.0.0"}}',
    { createPath: true },
  );
  await controlledBun(`const a = process.argv.slice(2).join(" ");
if (a === "pm bin -g") console.log(${JSON.stringify(`${root}/bun/bin`)});
else if (a === "pm ls -g") console.log(${JSON.stringify(`${root}/bun/install/global node_modules (1 installed)`)});
else process.exit(9);`);
  const before = await globalFiles();
  const result = await run(["install", "launcher", "--json"]);
  expect(result.code).toBe(3);
  expect(JSON.parse(result.stdout)).toMatchObject({
    operation: "install_launcher",
    outcome: "refused",
    reason: "launcher_unsupported",
  });
  expect(result.stderr).toContain("is not a built release");
  expect(await globalFiles()).toEqual(before);
  expect(await Bun.file(`${root}/bun/bin/operator`).exists()).toBe(false);
  expect((await Bun.file(`${root}/bun-requests`).text()).trim().split("\n")).toEqual([
    '["pm","bin","-g"]',
    '["pm","ls","-g"]',
  ]);
});

test("an unanswered global folder request writes nothing and exits as a blocker", async () => {
  await controlledBun("process.exit(1);");
  const result = await run(["install", "launcher", "--json"]);
  expect(result.code).toBe(3);
  expect(JSON.parse(result.stdout)).toMatchObject({ reason: "launcher_bun_failed" });
  expect(await globalFiles()).toEqual([]);
});

test("the launcher command accepts only its JSON flag", async () => {
  await controlledBun("process.exit(9);");
  for (const args of [
    ["install", "launcher", "--check"],
    ["install", "launcher", "--json", "--json"],
    ["install", "launcher", "extra"],
  ]) {
    const result = await run(args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("operator install launcher [--json]");
  }
  expect(await Bun.file(`${root}/bun-requests`).exists()).toBe(false);
});

test("an unreadable global manifest refuses before any launcher write", async () => {
  await Bun.write(`${root}/bun/install/global/package.json`, "{bad", { createPath: true });
  await controlledBun(`const a = process.argv.slice(2).join(" ");
if (a === "pm bin -g") console.log(${JSON.stringify(`${root}/bun/bin`)});
else if (a === "pm ls -g") console.log(${JSON.stringify(`${root}/bun/install/global node_modules (1 installed)`)});
else process.exit(9);`);
  const before = await globalFiles();
  const result = await run(["install", "launcher", "--json"]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ reason: "launcher_global_manifest_invalid" });
  expect(await globalFiles()).toEqual(before);
});
