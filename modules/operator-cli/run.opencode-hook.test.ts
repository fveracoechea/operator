import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
// Bun has no temporary-directory, chmod, symlink, or recursive removal API.
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Environment } from "../environment/main.ts";
import { registerTestDevice } from "../../scripts/device-fixture.ts";
import { writeUpstreamTools } from "../../scripts/upstream-tools-fixture.ts";

let root = "";
// Install also runs the upstream installer, so fake upstream tools sit outside the device root.
let tools = "";
const cli = Bun.fileURLToPath(new URL("../../cli.ts", import.meta.url));
const plugin = Bun.fileURLToPath(new URL("../opencode-plugin/plugin.ts", import.meta.url));
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-opencode-hook-"));
  tools = await mkdtemp(path.join(tmpdir(), "operator-opencode-hook-tools-"));
  await writeUpstreamTools(tools);
  // Herdr maps each OpenCode session to the pane that runs it.
  await Bun.write(
    `${tools}/tools/herdr`,
    `#!${process.execPath}\nif(process.argv.slice(2).join(" ") === "pane list") console.log(await Bun.file(${JSON.stringify(`${root}/panes.json`)}).text());\n`,
  );
  await chmod(`${tools}/tools/herdr`, 0o755);
  await Bun.write(
    `${root}/panes.json`,
    JSON.stringify({
      result: {
        panes: [
          {
            pane_id: "pane-1",
            tab_id: "t1",
            workspace_id: "w1",
            agent_session: { agent: "opencode", kind: "id", value: "ses_1" },
          },
        ],
      },
    }),
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(tools, { recursive: true, force: true });
});

// The shared OpenCode server carries the pane that started it, which the hook must not read.
function spawn(args: string[], stdin = "", env: Record<string, string | undefined> = {}) {
  return Bun.spawn([process.execPath, cli, ...args], {
    cwd: root,
    env: Environment.child({
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      PATH: `${tools}/tools`,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      HERDR_PANE_ID: "server-pane",
      ...env,
    }),
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function run(args: string[], stdin = "", env: Record<string, string | undefined> = {}) {
  const child = spawn(args, stdin, env);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function commit(command: string) {
  return JSON.stringify({
    event: "tool.execute.before",
    directory: root,
    input: { command, description: "Commit the change" },
  });
}

function idle(sessionID = "ses_1") {
  return JSON.stringify({ event: "session.idle", directory: root, sessionID });
}

const allowed = { code: 0, stdout: "", stderr: "" };

test("the plugin gets the reason that refuses a commit with a Co-Authored-By trailer", async () => {
  const result = await run(
    ["opencode", "hook"],
    commit('git commit -m "fix: x" -m "Co-Authored-By: Claude <noreply@anthropic.com>"'),
  );
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/Co-Authored-By.*commit again/s);
  expect(await run(["opencode", "hook"], commit('git commit -m "fix: x"'))).toEqual(allowed);
});

test("the commit check needs no device state, even when the state is incompatible", async () => {
  await Bun.write(`${root}/state/operator/operator.sqlite`, "not a database", {
    createPath: true,
  });
  const result = await run(
    ["opencode", "hook"],
    commit('git commit -m "Co-Authored-By: A <a@b.c>"'),
  );
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("Co-Authored-By");
  expect(await run(["opencode", "hook"], idle())).toEqual(allowed);
});

test("an invalid event fails with a reason for the person, which the plugin reads as no opinion", async () => {
  const result = await run(["opencode", "hook"], "{broken");
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("The OpenCode plugin did not describe a hook event.");
});

// Project commands read the checkout with the real git, not the upstream fixture's git.
const git = { PATH: path.dirname(Bun.which("git") ?? "") };

/** A registered project in the hook's directory with one source, whose id this returns. */
async function registeredSource() {
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["remote", "add", "origin", "https://github.com/example/one.git"],
  ]) {
    const child = Bun.spawn(["git", ...args], {
      cwd: root,
      env: Environment.child({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }),
    });
    expect(await child.exited).toBe(0);
  }
  expect((await run(["project", "register", "--json"], "", git)).code).toBe(0);
  const plan = {
    trackerKey: "github:example/one#10",
    assignments: [
      {
        key: "investigate",
        trackerKey: "github:example/one#11",
        instructions: "Read and report.",
        completion: "report",
        resources: "pane",
        dependencies: [],
      },
    ],
  };
  await Bun.write(`${root}/plan.json`, JSON.stringify(plan));
  const registered = await run(
    ["source", "register", "--file", `${root}/plan.json`, "--json"],
    "",
    git,
  );
  expect(registered.code, registered.stderr).toBe(0);
  return z.object({ data: z.object({ id: z.string() }) }).parse(JSON.parse(registered.stdout)).data
    .id;
}

function update(sql: string) {
  using db = new Database(`${root}/state/operator/operator.sqlite`);
  db.query(sql).run();
}

test("an idle session continues while it supervises running work and no wait runs", async () => {
  const id = await registeredSource();
  update(
    `UPDATE sources SET supervising_pane = 'server-pane', supervising_session = 'ses_1' WHERE id = '${id}'`,
  );
  // Ready work runs nothing.
  expect(await run(["opencode", "hook"], idle())).toEqual(allowed);
  update("UPDATE assignments SET state = 'running'");
  const continued = await run(["opencode", "hook"], idle());
  expect(continued.code, continued.stderr).toBe(0);
  expect(continued.stdout).toContain(`running work in ${id}`);
  // Another session in the same pane, such as a subagent's or a new one, supervises nothing.
  expect(await run(["opencode", "hook"], idle("ses_child"))).toEqual(allowed);
}, 30000);

test("install --opencode writes the plugin once, and check mode then passes", async () => {
  await registerTestDevice(root);
  const file = `${root}/config/opencode/plugins/operator.ts`;
  const first = await run(["install", "--opencode", "--json"]);
  expect(first.code, first.stderr).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({
    reason: "skills_installed",
    data: { hosts: ["opencode"], opencodePlugin: "installed" },
  });
  expect(first.stdout).not.toContain("claudeHook");
  expect(await Bun.file(file).text()).toBe(await Bun.file(plugin).text());
  const again = await run(["install", "--opencode", "--json"]);
  expect(JSON.parse(again.stdout)).toMatchObject({
    reason: "skills_already_installed",
    data: { opencodePlugin: "already_installed" },
  });
  expect(
    JSON.parse((await run(["install", "--opencode", "--check", "--json"])).stdout),
  ).toMatchObject({ reason: "skills_checked", data: { opencodePlugin: "already_installed" } });
  await rm(file);
  const missing = await run(["install", "--opencode", "--check", "--json"]);
  expect(missing.code).toBe(3);
  expect(JSON.parse(missing.stdout)).toMatchObject({ reason: "opencode_plugin_missing" });
  expect(await Bun.file(file).exists()).toBe(false);
  // Four CLI runs, two of them full installs, outlast the default timeout on a loaded machine.
}, 20000);

test("a dotfiles link refuses the write and names the file to link", async () => {
  await registerTestDevice(root);
  await Bun.write(`${root}/dotfiles/operator.ts`, "// OPERATOR_PLUGIN_VERSION=0\n", {
    createPath: true,
  });
  await mkdir(`${root}/config/opencode/plugins`, { recursive: true });
  await symlink(`${root}/dotfiles/operator.ts`, `${root}/config/opencode/plugins/operator.ts`);
  const result = await run(["install", "--opencode", "--json"]);
  expect(result.code).toBe(4);
  expect(JSON.parse(result.stdout)).toMatchObject({ reason: "opencode_plugin_external" });
  expect(result.stderr).toContain(`${plugin} to ${root}/config/opencode/plugins/operator.ts`);
  expect(await Bun.file(`${root}/dotfiles/operator.ts`).text()).toBe(
    "// OPERATOR_PLUGIN_VERSION=0\n",
  );
}, 15000);
