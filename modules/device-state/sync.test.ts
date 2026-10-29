import { afterAll, expect, test } from "bun:test";
// Bun has no descriptor listing, temporary-directory, or recursive removal API.
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncPath } from "./sync.ts";

const root = await mkdtemp(path.join(tmpdir(), "operator-sync-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("synchronizes files and folders without leaking a descriptor", async () => {
  await Bun.write(`${root}/file`, "content");
  const open = readdirSync("/dev/fd").length;
  expect(syncPath(`${root}/file`)).toBeUndefined();
  expect(syncPath(root)).toBeUndefined();
  expect(readdirSync("/dev/fd")).toHaveLength(open);
  expect(await Bun.file(`${root}/file`).text()).toBe("content");
});

test("a missing path fails with its filesystem code", () => {
  expect(() => syncPath(`${root}/missing`)).toThrow(expect.objectContaining({ code: "ENOENT" }));
});
