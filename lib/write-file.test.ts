import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory, directory listing, file metadata, or recursive removal API.
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeFile } from "./write-file.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "skill-write-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a replacement writes the bytes with the given mode and leaves no temporary file", async () => {
  await Bun.write(`${root}/target`, "old");
  // A zero mask keeps the mode the same on every host.
  const previous = process.umask(0);
  try {
    await writeFile(`${root}/target`, new TextEncoder().encode("bytes"), 0o640);
  } finally {
    process.umask(previous);
  }
  expect(await Bun.file(`${root}/target`).text()).toBe("bytes");
  expect((await stat(`${root}/target`)).mode % 0o1000).toBe(0o640);
  expect(await readdir(root)).toEqual(["target"]);
});

test("a failed replacement removes its temporary file", async () => {
  await Bun.write(`${root}/target/inside`, "", { createPath: true });
  await expect(writeFile(`${root}/target`, new TextEncoder().encode("bytes"))).rejects.toThrow();
  expect(await readdir(root)).toEqual(["target"]);
});
