import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory, chmod, chown, symlink, or recursive removal API.
import { chmod, chown, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { contents, identity, info, same, verdict, writable } from "./content.ts";
import { sha256 } from "../../lib/sha256.ts";

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
  await expect(info(`${root}/.asset/child`)).rejects.toMatchObject({ code: "ENOTDIR" });
});

test("records exact identities for nested files, single files, and special files", async () => {
  await Bun.write(`${root}/top`, "abc");
  await Bun.write(`${root}/nested/deeper/leaf`, "", { createPath: true });
  const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  expect(await contents(root, false)).toEqual({
    "/": "directory",
    top: abc,
    "nested/": "directory",
    "nested/deeper/": "directory",
    "nested/deeper/leaf": empty,
  });
  expect(await contents(`${root}/top`, false)).toEqual({ "": abc });
  await symlink("/dev/null", `${root}/device`);
  expect((await contents(root, true))?.device).toBe("special");
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
  expect((await contents(root))?.link).toBe("link");
  expect((await contents(root, true))?.link).toBe((await contents(root, true))?.asset);
  await symlink(root, `${root}/cycle`);
  const hash = (await contents(root, false))?.asset ?? "";
  expect(await contents(root, true)).toEqual({
    "/": "directory",
    asset: hash,
    link: hash,
    "cycle/": "directory",
    "cycle/asset": hash,
    "cycle/link": hash,
    "cycle/cycle": "cycle",
  });
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
  expect(verdict(null, null, old)).toBe("matching");
  expect(verdict(old, next, next)).toBe("conflict");
  expect(same(null, null)).toBe(true);
  expect(same({ file: "one" }, { file: "two" })).toBe(false);
  expect(same({ file: "one" }, { file: "one" })).toBe(true);
  expect(same(null, next)).toBe(false);
  expect(same(next, null)).toBe(false);
  expect(same(next, { ...next, other: "new" })).toBe(false);
  const inherited = { other: "value" };
  Object.setPrototypeOf(inherited, { file: "hash" });
  expect(same({ file: "hash" }, inherited)).toBe(false);
});

test("a writable managed root is enough even under a read-only parent", async () => {
  await mkdir(`${root}/locked/skills`, { recursive: true });
  await chmod(`${root}/locked`, 0o555);
  try {
    expect(await writable(`${root}/locked/skills`, `${root}/locked/skills/role`)).toBe(true);
    expect(await writable(`${root}/locked/absent`, `${root}/locked/absent/role`)).toBe(false);
  } finally {
    await chmod(`${root}/locked`, 0o755);
  }
});

test("an absent root takes the mode of its nearest existing ancestor", async () => {
  expect(await writable(`${root}/a/b`, `${root}/a/b/c`)).toBe(true);
  await mkdir(`${root}/read-only`);
  await chmod(`${root}/read-only`, 0o555);
  try {
    expect(await writable(`${root}/read-only/a/b`, `${root}/read-only/a/b/c`)).toBe(false);
  } finally {
    await chmod(`${root}/read-only`, 0o755);
  }
});

test("special mode bits do not make a read-only folder writable", async () => {
  await mkdir(`${root}/shared`);
  await chown(`${root}/shared`, userInfo().uid, userInfo().gid);
  await chmod(`${root}/shared`, 0o2555);
  try {
    expect(await writable(`${root}/shared`, `${root}/shared`)).toBe(false);
  } finally {
    await chmod(`${root}/shared`, 0o755);
  }
});

test("an identity hashes entries in code unit order of their paths", () => {
  const expected = '[["a-b","one"],["a/","directory"],["a/x","two"]]';
  expect(identity({ "a/": "directory", "a/x": "two", "a-b": "one" })).toBe(
    sha256(new TextEncoder().encode(expected)),
  );
});
