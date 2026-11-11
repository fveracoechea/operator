import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
// Bun has no temporary-directory, symlink, or recursive removal API.
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
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
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-claude-hook-"));
  tools = await mkdtemp(path.join(tmpdir(), "operator-claude-hook-tools-"));
  await writeUpstreamTools(tools);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(tools, { recursive: true, force: true });
});

function spawn(args: string[], stdin = "", env: Record<string, string | undefined> = {}) {
  return Bun.spawn([process.execPath, cli, ...args], {
    cwd: root,
    env: Environment.child({
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      PATH: `${tools}/tools`,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      HERDR_PANE_ID: undefined,
      OPENCODE_SESSION_ID: undefined,
      CLAUDE_CODE_SESSION_ID: undefined,
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
    hooks: {
      PreToolUse: [{ matcher: "Bash" }],
      Stop: [{ hooks: [{ command: "operator claude hook" }] }],
    },
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
  // Four CLI runs, two of them full installs, outlast the default timeout on a loaded machine.
}, 15000);

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
  // A full install and a check outlast the default timeout on a loaded machine.
}, 15000);

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

function stop(active = false, session = "ses-1") {
  return JSON.stringify({
    session_id: session,
    transcript_path: `${root}/t.jsonl`,
    cwd: root,
    permission_mode: "default",
    hook_event_name: "Stop",
    stop_hook_active: active,
  });
}

// Project commands read the checkout with the real git, not the upstream fixture's git.
const git = { PATH: path.dirname(Bun.which("git") ?? "") };

/** A registered project in the hook's cwd with one source, whose id this returns. */
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
  const project = await run(["project", "register", "--json"], "", git);
  expect(project.code, project.stderr).toBe(0);
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

/** Polls until the session's background wait records itself, as its process starts slowly under load. */
async function recordedWait(session = "ses-1") {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    {
      using db = new Database(`${root}/state/operator/operator.sqlite`, { readonly: true });
      // The background wait writes as it starts, so a read can meet its lock.
      db.exec("PRAGMA busy_timeout = 5000");
      const row = db
        .query<{ running: number }, [string]>(
          "SELECT count(*) AS running FROM coordination_waits WHERE owner_pid IS NOT NULL AND session = ?",
        )
        .get(session);
      if (row?.running === 1) return true;
    }
    await Bun.sleep(100);
  }
  return false;
}

function update(sql: string) {
  using db = new Database(`${root}/state/operator/operator.sqlite`);
  db.query(sql).run();
}

test("the turn-end guard blocks once while the session supervises running work and no wait runs", async () => {
  const id = await registeredSource();
  // The SuperAgent's wait runs in its Claude Code session, which names itself to its commands.
  const waitEnv = { ...git, HERDR_PANE_ID: "pane-1", CLAUDE_CODE_SESSION_ID: "ses-1" };
  const allowed = { code: 0, stdout: "", stderr: "" };
  expect((await run(["next", "--wait", "--timeout", "0", "--json"], "", waitEnv)).code).toBe(0);
  // Ready work runs nothing, so there is nothing to guard.
  expect(await run(["claude", "hook"], stop())).toEqual(allowed);
  update("UPDATE assignments SET state = 'running'");
  // A new session in the supervising pane, such as one after /clear, supervises nothing.
  expect(await run(["claude", "hook"], stop(false, "ses-2"), { HERDR_PANE_ID: "pane-1" })).toEqual(
    allowed,
  );
  const blocked = await run(["claude", "hook"], stop());
  expect(blocked.code, blocked.stderr).toBe(0);
  expect(JSON.parse(blocked.stdout)).toEqual({
    decision: "block",
    reason: expect.stringContaining(`This session supervises running work in ${id}`) as string,
  });
  // The turn that the block continued may end.
  expect(await run(["claude", "hook"], stop(true))).toEqual(allowed);
  expect((await run(["next", "--wait", "--timeout", "0", "--json"], "", waitEnv)).code).toBe(0);
  // A wait from the session covers the source while it runs, and another session's wait does not.
  const other = spawn(["next", "--wait", "--timeout", "60", "--json"], "", {
    ...waitEnv,
    CLAUDE_CODE_SESSION_ID: "ses-2",
  });
  try {
    expect(await recordedWait("ses-2")).toBe(true);
    expect(JSON.parse((await run(["claude", "hook"], stop())).stdout)).toMatchObject({
      decision: "block",
    });
  } finally {
    other.kill();
    await other.exited;
  }
  const waiting = spawn(["next", "--wait", "--timeout", "60", "--json"], "", waitEnv);
  try {
    expect(await recordedWait()).toBe(true);
    expect(await run(["claude", "hook"], stop())).toEqual(allowed);
  } finally {
    waiting.kill();
    await waiting.exited;
  }
  expect(JSON.parse((await run(["claude", "hook"], stop())).stdout)).toMatchObject({
    decision: "block",
  });
}, 60000);

test("the turn-end guard lets the turn end when device state is missing or incompatible", async () => {
  const pane = { HERDR_PANE_ID: "pane-1" };
  expect(await run(["claude", "hook"], stop(), pane)).toEqual({ code: 0, stdout: "", stderr: "" });
  await Bun.write(`${root}/state/operator/operator.sqlite`, "not a database", {
    createPath: true,
  });
  expect(await run(["claude", "hook"], stop(), pane)).toEqual({ code: 0, stdout: "", stderr: "" });
});
