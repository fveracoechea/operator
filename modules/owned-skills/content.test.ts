import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory, symlink, or recursive removal API.
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { contents, info, same, verdict, writable } from "./content.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "skill-contents-"));
});
afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

test("identifies binary assets, hidden files, and empty directories", async () => {
  await mkdir(`${root}/empty`);
  await Bun.write(`${root}/.asset`, new Uint8Array([0, 255, 1]));
  const found = await contents(root, false);
  expect(Object.keys(found ?? {}).toSorted()).toEqual([".asset", "/", "empty/"]);
  expect(found?.[".asset"]).toMatch(/^[a-f0-9]{64}$/);
  expect(await contents(`${root}/absent`, false)).toBeNull();
  expect(await info(`${root}/absent`)).toBeNull();
});

test("identifies prototype-named assets as own entries", async () => {
  await Bun.write(`${root}/__proto__`, "file bytes\n");
  const found = await contents(root, false);
  expect(found !== null && Object.hasOwn(found, "__proto__")).toBe(true);
  expect(Object.keys(found ?? {}).toSorted()).toEqual(["/", "__proto__"]);
  expect(same(Object.fromEntries([["__proto__", "bytes"]]), {})).toBe(false);
});

test("copy mode rejects links, while check mode follows them and terminates cycles", async () => {
  await Bun.write(`${root}/asset`, "value");
  await symlink(`${root}/asset`, `${root}/link`);
  expect((await contents(root, false))?.link).toBe("link");
  expect((await contents(root, true))?.link).toBe((await contents(root, true))?.asset);
  await symlink(root, `${root}/cycle`);
  expect(JSON.stringify(await contents(root, true))).toContain("cycle");
  expect(await writable(root, `${root}/link`)).toBe(false);
});

test("copy mode allows links above the managed root, like the macOS /var link", async () => {
  await mkdir(`${root}/real/skills/role`, { recursive: true });
  await symlink(`${root}/real`, `${root}/system`);
  expect(await writable(`${root}/system/skills`, `${root}/system/skills/role`)).toBe(true);
  expect(await writable(`${root}/system/absent`, `${root}/system/absent/role`)).toBe(true);
  await symlink(`${root}/real/skills`, `${root}/linked-skills`);
  expect(await writable(`${root}/linked-skills`, `${root}/linked-skills/role`)).toBe(false);
});

test("copy mode refuses an absent root under a read-only linked folder, like a Nix store link", async () => {
  await mkdir(`${root}/store`);
  await symlink(`${root}/store`, `${root}/config`);
  await chmod(`${root}/store`, 0o555);
  try {
    expect(await writable(`${root}/config/skills`, `${root}/config/skills/role`)).toBe(false);
  } finally {
    await chmod(`${root}/store`, 0o755);
  }
});

test("only an exact ledger identity permits an update or retired-name removal", () => {
  const old = { "/": "directory", "SKILL.md": "old" };
  const next = { "/": "directory", "SKILL.md": "new" };
  expect(verdict(null, next, null)).toBe("install");
  expect(verdict(next, next, null)).toBe("matching");
  expect(verdict(old, next, old)).toBe("update");
  expect(verdict(old, null, old)).toBe("remove");
  expect(verdict(old, next, null)).toBe("conflict");
  expect(verdict({ ...old, extra: "mine" }, next, old)).toBe("conflict");
  expect(verdict(old, null, null)).toBe("conflict");
  expect(same(null, next)).toBe(false);
  expect(same(next, null)).toBe(false);
  expect(same(next, { ...next, other: "new" })).toBe(false);
  const inherited = { other: "value" };
  Object.setPrototypeOf(inherited, { file: "hash" });
  expect(same({ file: "hash" }, inherited)).toBe(false);
});
