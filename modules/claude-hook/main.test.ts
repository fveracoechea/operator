import { afterAll, afterEach, expect, expectTypeOf, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory, chmod, or recursive removal API.
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Ok } from "unthrown";
import { z } from "zod";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { ClaudeHook } from "./main.ts";

const root = await mkdtemp(path.join(tmpdir(), "claude-hook-api-"));
afterEach(() => {
  mock.restore();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));

function event(command: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    session_id: "s",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "Commit" },
    cwd: root,
    ...overrides,
  });
}

test("the public failure reasons form a closed union", () => {
  type Failure =
    | Extract<Awaited<ReturnType<typeof ClaudeHook.answer>>, { tag: "Err" }>["error"]
    | Extract<Awaited<ReturnType<typeof ClaudeHook.install>>, { tag: "Err" }>["error"];
  expectTypeOf<Failure["reason"]>().not.toEqualTypeOf<string>();
});

test("a commit with a Co-Authored-By trailer gets a deny decision with the fix", async () => {
  const result = await ClaudeHook.answer({
    event: event('git commit -m "fix: x" -m "Co-Authored-By: Claude <noreply@anthropic.com>"'),
    paths,
  });
  expect(result.tag).toBe("Ok");
  if (result.tag !== "Ok") return;
  const answer = z
    .strictObject({
      hookSpecificOutput: z.strictObject({
        hookEventName: z.literal("PreToolUse"),
        permissionDecision: z.literal("deny"),
        permissionDecisionReason: z.string(),
      }),
    })
    .parse(JSON.parse(result.value));
  expect(answer.hookSpecificOutput.permissionDecisionReason).toMatch(
    /Co-Authored-By.*commit again/s,
  );
});

test("every other event gets no answer, so Claude Code keeps its own permission flow", async () => {
  for (const input of [
    event('git commit -m "fix: x"'),
    event("ls"),
    event('git commit -m "Co-Authored-By: A"', { tool_name: "Write" }),
    event('git commit -m "Co-Authored-By: A"', { hook_event_name: "PostToolUse" }),
    event("", { tool_input: { file_path: "a.ts" } }),
    event("", { tool_input: { command: ['git commit -m "Co-Authored-By: A"'] } }),
  ])
    expect(await ClaudeHook.answer({ event: input, paths })).toMatchObject({
      tag: "Ok",
      value: "",
    });
});

function stop(active: boolean) {
  return JSON.stringify({
    session_id: "s",
    hook_event_name: "Stop",
    stop_hook_active: active,
    cwd: root,
  });
}

test("a Stop event in a pane with unwatched running work blocks the turn's end", async () => {
  spyOn(Environment, "read").mockReturnValue({
    ...Environment.read(),
    HERDR_PANE_ID: "pane-1",
  });
  const unwatched = spyOn(WorkSources, "unwatched").mockReturnValue(Ok(["one"]));
  expect(await ClaudeHook.answer({ event: stop(false), paths })).toMatchObject({
    tag: "Ok",
    value: expect.stringContaining('"decision":"block"') as string,
  });
  expect(unwatched).toHaveBeenCalledWith({ paths, cwd: root, paneId: "pane-1" });
  // The turn that the block continued may end.
  expect(await ClaudeHook.answer({ event: stop(true), paths })).toMatchObject({
    tag: "Ok",
    value: "",
  });
});

test("a Stop event on a device with no state lets the turn end", async () => {
  spyOn(Environment, "read").mockReturnValue({
    ...Environment.read(),
    HERDR_PANE_ID: "pane-1",
  });
  expect(await ClaudeHook.answer({ event: stop(false), paths })).toMatchObject({
    tag: "Ok",
    value: "",
  });
});

test("an event that is not Claude Code hook JSON is refused", async () => {
  for (const input of [
    "",
    "{broken",
    "[]",
    JSON.stringify({ tool_name: "Bash" }),
    JSON.stringify({ hook_event_name: "Stop", cwd: root }),
  ])
    expect(await ClaudeHook.answer({ event: input, paths })).toMatchObject({
      tag: "Err",
      error: { reason: "claude_hook_event_invalid" },
    });
});

test("install writes the user settings, and check mode then passes", async () => {
  expect(await ClaudeHook.install({ paths, check: true })).toMatchObject({
    tag: "Err",
    error: { reason: "claude_hook_missing" },
  });
  expect(await ClaudeHook.install({ paths, check: false })).toMatchObject({
    tag: "Ok",
    value: "installed",
  });
  expect(await Bun.file(`${root}/.claude/settings.json`).json()).toMatchObject({
    hooks: { PreToolUse: [{ matcher: "Bash" }], Stop: [{}] },
  });
  expect(await ClaudeHook.install({ paths, check: true })).toMatchObject({
    tag: "Ok",
    value: "already_installed",
  });
});

test("an unreadable settings file is a filesystem failure, not a defect", async () => {
  await Bun.write(`${root}/.claude/settings.json`, "{}");
  await chmod(`${root}/.claude/settings.json`, 0o000);
  try {
    expect(await ClaudeHook.install({ paths, check: true })).toMatchObject({
      tag: "Err",
      error: { reason: "claude_settings_io_failed" },
    });
  } finally {
    await rm(`${root}/.claude/settings.json`);
  }
});

test("tests cannot reach a settings file outside a temporary root", async () => {
  const real = OperatorHome.resolve(Environment.parse({ HOME: "/Users/nobody", NODE_ENV: "test" }));
  expect(await ClaudeHook.install({ paths: real, check: true })).toMatchObject({ tag: "Defect" });
});

test.each([
  "ENOENT",
  "EACCES",
  "EPERM",
  "EIO",
  "EROFS",
  "ENOSPC",
  "ENOTDIR",
  "EISDIR",
  "EEXIST",
  "ELOOP",
])("a %s failure is a settings I/O refusal", async (code) => {
  const spy = spyOn(OperatorHome, "guardTemporaryTests").mockImplementation(() => {
    // oxlint-disable-next-line unthrown/no-throw -- Inject a coded failure at the public module boundary.
    throw Object.assign(new Error("failed"), { code });
  });
  try {
    expect(await ClaudeHook.install({ paths, check: false })).toMatchObject({
      tag: "Err",
      error: { reason: "claude_settings_io_failed", detail: "Error: failed" },
    });
  } finally {
    spy.mockRestore();
  }
});

test("other coded failures remain defects", async () => {
  const spy = spyOn(OperatorHome, "guardTemporaryTests").mockImplementation(() => {
    // oxlint-disable-next-line unthrown/no-throw -- Inject a coded failure at the public module boundary.
    throw Object.assign(new Error("busy"), { code: "EBUSY" });
  });
  try {
    expect(await ClaudeHook.install({ paths, check: false })).toMatchObject({ tag: "Defect" });
  } finally {
    spy.mockRestore();
  }
});
