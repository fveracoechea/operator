import { afterAll, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory, chmod, symlink, or recursive removal API.
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installPlugin, pluginFile } from "./install.ts";

const root = await mkdtemp(path.join(tmpdir(), "opencode-plugin-install-"));
const file = `${root}/opencode/plugins/operator.ts`;
const shipped = await Bun.file(pluginFile).text();
const version = Number(/^\/\/ OPERATOR_PLUGIN_VERSION=(\d+)$/m.exec(shipped)?.[1]);
beforeEach(async () => {
  await chmod(root, 0o700);
  await rm(`${root}/opencode`, { recursive: true, force: true });
  await rm(`${root}/dotfiles`, { recursive: true, force: true });
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("the shipped plugin carries a version marker", () => {
  expect(version).toBeGreaterThan(0);
});

test("a missing file is written in place, and check mode only reports it", async () => {
  expect(await installPlugin({ file, check: true })).toMatchObject({
    reason: "opencode_plugin_missing",
    detail: expect.stringContaining(`link or copy ${pluginFile} to ${file}`) as string,
  });
  expect(await Bun.file(file).exists()).toBe(false);
  expect(await installPlugin({ file, check: false })).toEqual({ reason: "installed" });
  expect(await Bun.file(file).text()).toBe(shipped);
});

test("a copy with the release's version passes whatever its other bytes", async () => {
  const copy = `// OPERATOR_PLUGIN_VERSION=${version}\n// edited by the person\n`;
  await Bun.write(file, copy);
  for (const check of [true, false])
    expect(await installPlugin({ file, check })).toEqual({ reason: "already_installed" });
  expect(await Bun.file(file).text()).toBe(copy);
});

test("another version is reported in check mode and replaced by install", async () => {
  for (const other of [version - 1, version + 1]) {
    await Bun.write(file, `// OPERATOR_PLUGIN_VERSION=${other}\n`);
    expect(await installPlugin({ file, check: true })).toMatchObject({
      reason: "opencode_plugin_outdated",
      detail: expect.stringContaining(
        `version ${other}, and this release runs version ${version}`,
      ) as string,
    });
    expect(await installPlugin({ file, check: false })).toEqual({ reason: "installed" });
    expect(await Bun.file(file).text()).toBe(shipped);
  }
});

test("a file with no marker belongs to the person and stays unchanged", async () => {
  await Bun.write(file, "export default { id: 'mine' }\n");
  expect(await installPlugin({ file, check: true })).toMatchObject({
    reason: "opencode_plugin_missing",
  });
  expect(await installPlugin({ file, check: false })).toMatchObject({
    reason: "opencode_plugin_external",
    detail: expect.stringContaining(`to ${file}`) as string,
  });
  expect(await Bun.file(file).text()).toBe("export default { id: 'mine' }\n");
});

test("a linked file or folder belongs to its owner and stays unchanged", async () => {
  await Bun.write(`${root}/dotfiles/operator.ts`, `// OPERATOR_PLUGIN_VERSION=${version - 1}\n`);
  await mkdir(path.dirname(file), { recursive: true });
  await symlink(`${root}/dotfiles/operator.ts`, file);
  expect(await installPlugin({ file, check: false })).toMatchObject({
    reason: "opencode_plugin_external",
  });
  expect(await Bun.file(`${root}/dotfiles/operator.ts`).text()).toBe(
    `// OPERATOR_PLUGIN_VERSION=${version - 1}\n`,
  );
  await rm(`${root}/opencode`, { recursive: true });
  await mkdir(`${root}/dotfiles/plugins`, { recursive: true });
  await mkdir(`${root}/opencode`, { recursive: true });
  await symlink(`${root}/dotfiles/plugins`, path.dirname(file));
  expect(await installPlugin({ file, check: false })).toMatchObject({
    reason: "opencode_plugin_external",
  });
  expect(await Bun.file(`${root}/dotfiles/plugins/operator.ts`).exists()).toBe(false);
});

test("a read-only folder refuses the write and names the file to link", async () => {
  await mkdir(path.dirname(file), { recursive: true });
  await chmod(path.dirname(file), 0o500);
  try {
    expect(await installPlugin({ file, check: false })).toMatchObject({
      reason: "opencode_plugin_external",
    });
  } finally {
    await chmod(path.dirname(file), 0o700);
  }
  expect(await Bun.file(file).exists()).toBe(false);
});
