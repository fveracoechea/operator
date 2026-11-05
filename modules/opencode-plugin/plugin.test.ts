import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory, chmod, or recursive removal API.
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import plugin from "./plugin.ts";

type Context = Parameters<typeof plugin.setup>[0];
type Idle = Parameters<Parameters<Context["session"]["hook"]>[1]>[0];

const root = await mkdtemp(path.join(tmpdir(), "opencode-plugin-shim-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// The plugin runs `operator` from PATH. This controlled stand-in records each event it reads and
// answers with the reason and exit code that a test writes.
const fake = `${root}/operator`;
await Bun.write(
  fake,
  `#!/bin/sh\ncat >> "${root}/events.jsonl"\necho >> "${root}/events.jsonl"\ncat "${root}/reason"\nexit $(cat "${root}/code")\n`,
);
await chmod(fake, 0o755);
const realSpawn = Bun.spawn;

async function answer(reason: string, code = 0) {
  await Bun.write(`${root}/reason`, reason);
  await Bun.write(`${root}/code`, String(code));
}

async function events() {
  const file = Bun.file(`${root}/events.jsonl`);
  if (!(await file.exists())) return [];
  return (await file.text())
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
}

let spawn: ReturnType<typeof spyOn<typeof Bun, "spawn">>;
beforeEach(async () => {
  await rm(`${root}/events.jsonl`, { force: true });
  await answer("");
  spawn = spyOn(Bun, "spawn").mockImplementation(((
    command: string[],
    options: Parameters<typeof Bun.spawn>[1],
  ) => realSpawn([fake, ...command.slice(1)], options)) as typeof Bun.spawn);
});
afterEach(() => {
  mock.restore();
});

/** Sets the plugin up on a stand-in context and returns the hooks it registered. */
async function setup() {
  const prompt: Array<(event: { sessionID: string }) => void> = [];
  const idle: Array<(event: Idle) => Promise<void>> = [];
  const before: Array<(event: { tool: string; input: unknown }) => Promise<void>> = [];
  const synthetic = mock(async (_input: { sessionID: string; text: string }) => {});
  const ctx = {
    location: { directory: root },
    session: {
      hook: async (name: string, callback: never) => {
        if (name === "prompt") prompt.push(callback);
        else idle.push(callback);
      },
      synthetic,
    },
    tool: {
      hook: async (_name: string, callback: never) => {
        before.push(callback);
      },
    },
  };
  await plugin.setup(ctx as Context);
  return {
    synthetic,
    prompt: (sessionID: string) => {
      for (const callback of prompt) callback({ sessionID });
    },
    idle: async (event: Idle) => {
      for (const callback of idle) await callback(event);
    },
    before: async (event: { tool: string; input: unknown }) => {
      for (const callback of before) await callback(event);
    },
  };
}

test("the plugin has the id and setup shape that OpenCode 2 loads", () => {
  expect(plugin.id).toBe("operator");
  expect(plugin.setup).toBeInstanceOf(Function);
});

test("a shell git commit asks Operator, and its reason refuses the tool call", async () => {
  const hooks = await setup();
  await answer("Remove the trailer.");
  const input = { command: 'git commit -m "Co-Authored-By: A"', workdir: "sub" };
  await expect(hooks.before({ tool: "shell", input })).rejects.toThrow("Remove the trailer.");
  expect(await events()).toEqual([{ event: "tool.execute.before", directory: root, input }]);
});

test("a commit with no reason, or a failed Operator, leaves the tool call alone", async () => {
  const hooks = await setup();
  const input = { command: 'git commit -m "fix: x"' };
  expect(await hooks.before({ tool: "shell", input })).toBeUndefined();
  await answer("Remove the trailer.", 1);
  expect(await hooks.before({ tool: "shell", input })).toBeUndefined();
  spawn.mockImplementation(() => {
    // oxlint-disable-next-line unthrown/no-throw -- Bun.spawn throws when the command is not on PATH.
    throw new Error("Executable not found in $PATH: operator");
  });
  expect(await hooks.before({ tool: "shell", input })).toBeUndefined();
});

test("other tools and other shell commands start no Operator process", async () => {
  const hooks = await setup();
  await hooks.before({ tool: "write", input: { command: "git commit" } });
  await hooks.before({ tool: "shell", input: { command: "git status" } });
  await hooks.before({ tool: "shell", input: null });
  expect(spawn).not.toHaveBeenCalled();
});

test("an idle session continues once with Operator's reason until the person prompts again", async () => {
  const hooks = await setup();
  await answer("Start the wait.");
  await hooks.idle({ sessionID: "ses_1", background: [] });
  expect(hooks.synthetic.mock.calls).toEqual([[{ sessionID: "ses_1", text: "Start the wait." }]]);
  expect(await events()).toEqual([{ event: "session.idle", directory: root, sessionID: "ses_1" }]);
  // The continuation ran, and the session may now go idle.
  await hooks.idle({ sessionID: "ses_1", background: [] });
  expect(spawn).toHaveBeenCalledTimes(1);
  // Another session keeps its own allowance.
  await hooks.idle({ sessionID: "ses_2" });
  expect(hooks.synthetic).toHaveBeenCalledTimes(2);
  hooks.prompt("ses_1");
  await hooks.idle({ sessionID: "ses_1", background: [] });
  expect(hooks.synthetic).toHaveBeenCalledTimes(3);
});

test("an idle session whose own background wait runs starts no Operator process", async () => {
  const hooks = await setup();
  await answer("Start the wait.");
  await hooks.idle({
    sessionID: "ses_1",
    background: [{ kind: "shell", sessionID: "ses_1", command: "operator next --wait --json" }],
  });
  expect(spawn).not.toHaveBeenCalled();
  // A wait that another session runs does not cover this one.
  await hooks.idle({
    sessionID: "ses_1",
    background: [
      { kind: "shell", sessionID: "ses_child", command: "operator next --wait --json" },
      { kind: "subagent", sessionID: "ses_1" },
    ],
  });
  expect(hooks.synthetic).toHaveBeenCalledTimes(1);
});

test("a background wait that ran restores the allowance, so a woken turn is guarded again", async () => {
  const hooks = await setup();
  await answer("Start the wait.");
  await hooks.idle({ sessionID: "ses_1" });
  await hooks.idle({ sessionID: "ses_1" });
  expect(hooks.synthetic).toHaveBeenCalledTimes(1);
  // The SuperAgent started the wait, and its notice woke the session after a worker event.
  await hooks.idle({
    sessionID: "ses_1",
    background: [{ kind: "shell", sessionID: "ses_1", command: "operator next --wait --json" }],
  });
  await hooks.idle({ sessionID: "ses_1" });
  expect(hooks.synthetic).toHaveBeenCalledTimes(2);
  await hooks.idle({ sessionID: "ses_1" });
  expect(hooks.synthetic).toHaveBeenCalledTimes(2);
});

test("an idle session with no reason, or a refused continuation, goes idle", async () => {
  const hooks = await setup();
  await hooks.idle({ sessionID: "ses_1" });
  expect(hooks.synthetic).not.toHaveBeenCalled();
  await answer("Start the wait.");
  hooks.synthetic.mockRejectedValueOnce(new Error("session busy"));
  expect(await hooks.idle({ sessionID: "ses_1" })).toBeUndefined();
});
