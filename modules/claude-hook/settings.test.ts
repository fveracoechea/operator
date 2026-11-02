import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory, chmod, symlink, or recursive removal API.
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hookEntry, installHook, refusedWrite } from "./settings.ts";

let root = "";
let file = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "claude-hook-settings-"));
  file = `${root}/.claude/settings.json`;
});
afterEach(async () => {
  await chmod(`${root}/.claude`, 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

test("a new device gets a settings file with only the hook", async () => {
  expect(await installHook({ file, check: false })).toEqual({ reason: "installed" });
  expect(await Bun.file(file).json()).toEqual({
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", if: "Bash(git *)", command: "operator claude hook" }],
        },
      ],
    },
  });
});

test("the hook joins existing settings and hooks without changing them", async () => {
  const own = { matcher: "Edit", hooks: [{ type: "command", command: "format" }] };
  await Bun.write(
    file,
    JSON.stringify({ model: "opus", hooks: { PreToolUse: [own], Stop: [own] } }),
    { createPath: true },
  );
  expect(await installHook({ file, check: false })).toEqual({ reason: "installed" });
  expect(await Bun.file(file).json()).toEqual({
    model: "opus",
    hooks: { PreToolUse: [own, hookEntry], Stop: [own] },
  });
});

test("a repeated install leaves the file unwritten", async () => {
  await installHook({ file, check: false });
  const before = await Bun.file(file).text();
  await Bun.write(file, `${before}\n\n`);
  expect(await installHook({ file, check: false })).toEqual({ reason: "already_installed" });
  expect(await Bun.file(file).text()).toBe(`${before}\n\n`);
});

test("any PreToolUse group that runs the hook command counts as installed", async () => {
  const entry = {
    matcher: "*",
    hooks: [
      { type: "command", command: "format" },
      { type: "command", command: "operator claude hook" },
    ],
  };
  await Bun.write(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit" }, entry] } }), {
    createPath: true,
  });
  expect(await installHook({ file, check: true })).toEqual({ reason: "already_installed" });
});

test("check mode reports a missing hook and writes nothing", async () => {
  const result = await installHook({ file, check: true });
  expect(result).toMatchObject({ reason: "claude_hook_missing" });
  expect("detail" in result && result.detail).toContain(JSON.stringify(hookEntry));
  expect(await Bun.file(file).exists()).toBe(false);
});

test("a linked settings file belongs to its owner, so install names the entry to add", async () => {
  await Bun.write(`${root}/dotfiles/settings.json`, "{}\n", { createPath: true });
  await mkdir(`${root}/.claude`);
  await symlink(`${root}/dotfiles/settings.json`, file);
  const result = await installHook({ file, check: false });
  expect(result).toMatchObject({ reason: "claude_settings_external" });
  expect("detail" in result && result.detail).toContain(JSON.stringify(hookEntry));
  expect(await Bun.file(`${root}/dotfiles/settings.json`).text()).toBe("{}\n");
});

test("a linked settings folder belongs to its owner", async () => {
  await mkdir(`${root}/dotfiles`);
  await symlink(`${root}/dotfiles`, `${root}/.claude`);
  expect(await installHook({ file, check: false })).toMatchObject({
    reason: "claude_settings_external",
  });
  expect(await Bun.file(`${root}/dotfiles/settings.json`).exists()).toBe(false);
});

test("a read-only settings folder belongs to its owner", async () => {
  await Bun.write(file, "{}\n", { createPath: true });
  await chmod(`${root}/.claude`, 0o555);
  expect(await installHook({ file, check: false })).toMatchObject({
    reason: "claude_settings_external",
  });
});

test.each([
  ["{broken"],
  ["[]"],
  ['{"hooks":{"PreToolUse":{}}}'],
  ['{"hooks":{"PreToolUse":[{"hooks":{}}]}}'],
])("settings that are not a settings object are refused: %s", async (text) => {
  await Bun.write(file, text, { createPath: true });
  const result = await installHook({ file, check: false });
  expect(result).toMatchObject({ reason: "claude_settings_invalid" });
  expect("detail" in result && result.detail).toContain(file);
  expect(await Bun.file(file).text()).toBe(text);
});

test("an unreadable settings file is a file system failure, not invalid settings", async () => {
  await Bun.write(file, "{}\n", { createPath: true });
  await chmod(file, 0o000);
  await expect(installHook({ file, check: true })).rejects.toMatchObject({ code: "EACCES" });
});

test("a settings path under a file is a file system failure", async () => {
  await Bun.write(`${root}/.claude`, "not a folder\n");
  // The platform names the failure EEXIST or ENOTDIR.
  await expect(installHook({ file, check: false })).rejects.toThrow(/EEXIST|ENOTDIR/);
});

test.each(["EACCES", "EPERM", "EROFS"])("a %s write belongs to the file owner", (code) => {
  expect(refusedWrite(Object.assign(new Error("failed"), { code }))).toBe(true);
});

test("other write failures are not a refusal", () => {
  expect(refusedWrite(Object.assign(new Error("failed"), { code: "EIO" }))).toBe(false);
});
