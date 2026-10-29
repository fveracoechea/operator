import { afterEach, expect, test } from "bun:test";
// Bun has no temporary directory, symbolic link, or recursive removal API.
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { realPathOrNull } from "./real-path.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("resolves links to the real file and returns null for a missing file", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-real-path-")));
  roots.push(root);
  await Bun.write(`${root}/target`, "file\n");
  await symlink(`${root}/target`, `${root}/link`);
  await symlink(`${root}/missing`, `${root}/dangling`);
  expect(await realPathOrNull(`${root}/link`)).toBe(`${root}/target`);
  expect(await realPathOrNull(`${root}/target`)).toBe(`${root}/target`);
  expect(await realPathOrNull(`${root}/missing`)).toBeNull();
  expect(await realPathOrNull(`${root}/dangling`)).toBeNull();
});
