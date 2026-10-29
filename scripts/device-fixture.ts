import { expect } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../modules/environment/main.ts";

/** Give command tests a registered device before they measure the command's effects. */
export async function registerTestDevice(root: string, stateHome = `${root}/state`) {
  const checkout = await mkdtemp(path.join(tmpdir(), "operator-registration-fixture-"));
  const env = Environment.child({
    HOME: `${root}/home`,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_STATE_HOME: stateHome,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  });
  try {
    for (const args of [
      ["git", "init", "-q", checkout],
      [
        "git",
        "-C",
        checkout,
        "remote",
        "add",
        "origin",
        "https://github.com/fixture/registered.git",
      ],
      [
        process.execPath,
        Bun.fileURLToPath(new URL("../cli.ts", import.meta.url)),
        "project",
        "register",
        "--json",
      ],
    ]) {
      const child = Bun.spawn(args, { cwd: checkout, env, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, `${stdout}${stderr}`).toBe(0);
    }
    return await Bun.file(`${stateHome}/operator/operator.sqlite`).arrayBuffer();
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
}
