import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory, realpath, symlink, or recursive removal API.
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installedUnchanged, recordInstalled } from "./installed.ts";

let worktree = "";

function sha256(text: string) {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

beforeEach(async () => {
  worktree = await realpath(await mkdtemp(path.join(tmpdir(), "operator-installed-")));
  for (const file of [".husky/_/h", ".husky/_/.gitignore", "dist/a.js", "dist/sub/b.js", "old"])
    await Bun.write(`${worktree}/${file}`, `${file}\n`, { createPath: true });
  await mkdir(`${worktree}/empty`);
  await symlink(`${worktree}/old`, `${worktree}/link`);
});

afterEach(async () => {
  await rm(worktree, { recursive: true, force: true });
});

test("the record holds each new regular file with its content hash", async () => {
  const record = await recordInstalled({
    worktree,
    before: new Set(["old"]),
    after: ["old", ".husky/_/h", "link", "empty", "gone"],
  });
  expect(JSON.parse(record)).toEqual([{ path: ".husky/_/h", hash: sha256(".husky/_/h\n") }]);
});

test("recorded files and folders count while each of their files is unchanged", async () => {
  const record = await recordInstalled({
    worktree,
    before: new Set(),
    after: [".husky/_/h", ".husky/_/.gitignore", "dist/a.js", "dist/sub/b.js", "old"],
  });
  await Bun.write(`${worktree}/old`, "changed\n");
  await Bun.write(`${worktree}/notes`, "mine\n");
  const ignored = [".husky/_/h", ".husky/_/", "dist/", "old", "notes", "empty/"];
  expect(await installedUnchanged({ worktree, record, ignored })).toEqual(
    new Set([".husky/_/h", ".husky/_/", "dist/"]),
  );
  await Bun.write(`${worktree}/dist/sub/c.js`, "new\n");
  await symlink(`${worktree}/old`, `${worktree}/.husky/_/link`);
  expect(await installedUnchanged({ worktree, record, ignored })).toEqual(new Set([".husky/_/h"]));
});

test.each([
  { name: "no record", record: null },
  { name: "a record that is not JSON", record: "{" },
  { name: "a record of another shape", record: JSON.stringify([{ path: ".husky/_/h" }]) },
])("$name holds no install output", async ({ record }) => {
  expect(await installedUnchanged({ worktree, record, ignored: [".husky/_/h"] })).toEqual(
    new Set(),
  );
});
