import { afterEach, expect, test } from "bun:test";
import { Environment } from "../environment/main.ts";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { identifyArtifact, scanFiles } from "./inventory.ts";

const root = `${Environment.read().TMPDIR ?? "/tmp"}/operator-inventory-${crypto.randomUUID()}`;
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("missing inventory is empty and paths use stable code-point order", async () => {
  expect(await scanFiles(root)).toEqual([]);
  await Bun.write(`${root}/a`, "lower", { createPath: true });
  await Bun.write(`${root}/Z`, "upper");
  expect(await scanFiles(root)).toEqual(["Z", "a"]);
});

test("an unexpected inventory I/O defect is not treated as an empty directory", async () => {
  const notDirectory = `${root}/file`;
  await Bun.write(notDirectory, "not a directory", { createPath: true });
  await expect(scanFiles(notDirectory)).rejects.toMatchObject({ code: "ENOTDIR" });
  expect(await Bun.file(notDirectory).text()).toBe("not a directory");
});

test("artifact identity covers file names and bytes but excludes its own release record", async () => {
  await Bun.write(`${root}/file`, "first", { createPath: true });
  const original = await identifyArtifact(root);
  await Bun.write(`${root}/release.json`, "record");
  expect(await identifyArtifact(root)).toBe(original);
  await Bun.write(`${root}/file`, "second");
  expect(await identifyArtifact(root)).not.toBe(original);
  await rm(`${root}/file`);
  await Bun.write(`${root}/renamed`, "first");
  expect(await identifyArtifact(root)).not.toBe(original);
});
