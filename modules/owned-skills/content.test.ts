import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory, symlink, or recursive removal API.
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
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
  expect(await writable(`${root}/link`)).toBe(false);
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
