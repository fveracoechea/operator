import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory, symlink, or recursive removal API.
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { registerTestDevice } from "../../scripts/device-fixture.ts";

let root = "";
const cli = Bun.fileURLToPath(new URL("../../cli.ts", import.meta.url));
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-claude-hook-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function run(args: string[], stdin = "") {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: root,
    env: Environment.child({
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    }),
    stdin: new TextEncoder().encode(stdin),
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

function event(command: string) {
  return JSON.stringify({
    session_id: "s",
    transcript_path: `${root}/t.jsonl`,
    cwd: root,
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "Commit the change" },
    tool_use_id: "toolu_1",
  });
}

test("Claude Code gets a deny decision for a commit with a Co-Authored-By trailer", async () => {
  const result = await run(
    ["claude", "hook"],
    event('git commit -m "fix: x" -m "Co-Authored-By: Claude <noreply@anthropic.com>"'),
  );
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
  });
});

test("a commit without the trailer gets no output, so Claude Code decides as usual", async () => {
  expect(await run(["claude", "hook"], event('git commit -m "fix: x"'))).toEqual({
    code: 0,
    stdout: "",
    stderr: "",
  });
});

test("the hook needs no device state, even when the state is incompatible", async () => {
  await Bun.write(`${root}/state/operator/operator.sqlite`, "not a database", {
    createPath: true,
  });
  const result = await run(["claude", "hook"], event('git commit -m "Co-Authored-By: A <a@b.c>"'));
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain('"deny"');
});

test("an invalid event fails open with a reason for the person, not a block", async () => {
  const result = await run(["claude", "hook"], "{broken");
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Claude Code did not describe a hook event.");
});

test("install --claude adds the hook to user settings once", async () => {
  await registerTestDevice(root);
  await Bun.write(`${root}/home/.claude/settings.json`, '{"model":"opus"}', { createPath: true });
  const first = await run(["install", "--claude", "--json"]);
  expect(first.code, first.stderr).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({
    reason: "skills_installed",
    data: { hosts: ["claude-code"], claudeHook: "installed" },
  });
  const settings = await Bun.file(`${root}/home/.claude/settings.json`).text();
  expect(JSON.parse(settings)).toMatchObject({
    model: "opus",
    hooks: { PreToolUse: [{ matcher: "Bash" }] },
  });
  const again = await run(["install", "--claude", "--json"]);
  expect(JSON.parse(again.stdout)).toMatchObject({
    reason: "skills_already_installed",
    data: { claudeHook: "already_installed" },
  });
  expect(await Bun.file(`${root}/home/.claude/settings.json`).text()).toBe(settings);
  expect(
    JSON.parse((await run(["install", "--claude", "--check", "--json"])).stdout),
  ).toMatchObject({ reason: "skills_checked", data: { claudeHook: "already_installed" } });
});

test("install --opencode leaves Claude Code settings alone", async () => {
  await registerTestDevice(root);
  const result = await run(["install", "--opencode", "--json"]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).not.toContain("claudeHook");
  expect(await Bun.file(`${root}/home/.claude/settings.json`).exists()).toBe(false);
});

test("check mode names the missing hook", async () => {
  await registerTestDevice(root);
  expect((await run(["install", "--claude", "--json"])).code).toBe(0);
  await Bun.write(`${root}/home/.claude/settings.json`, "{}");
  const result = await run(["install", "--claude", "--check", "--json"]);
  expect(result.code).toBe(3);
  expect(JSON.parse(result.stdout)).toMatchObject({ reason: "claude_hook_missing" });
});

test("a dotfiles link refuses the write and names the entry to add", async () => {
  await registerTestDevice(root);
  await Bun.write(`${root}/dotfiles/settings.json`, "{}\n", { createPath: true });
  await mkdir(`${root}/home/.claude`, { recursive: true });
  await symlink(`${root}/dotfiles/settings.json`, `${root}/home/.claude/settings.json`);
  const result = await run(["install", "--claude", "--json"]);
  expect(result.code).toBe(4);
  expect(JSON.parse(result.stdout)).toMatchObject({ reason: "claude_settings_external" });
  expect(result.stderr).toContain('"command":"operator claude hook"');
  expect(await Bun.file(`${root}/dotfiles/settings.json`).text()).toBe("{}\n");
});
