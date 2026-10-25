import { afterAll, expect, test } from "bun:test";
// Bun has no temporary directory or recursive removal API.
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { changedRanges, parseMutationArgs, selectMutationUnits } from "./mutation-selection.ts";

const root = await mkdtemp(path.join(tmpdir(), "operator-mutation-selection-"));
afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

test("selection requires explicit units or a ref, with optional unit limits", () => {
  expect(parseMutationArgs([])).toHaveProperty("error");
  expect(parseMutationArgs(["--since"])).toHaveProperty("error");
  expect(parseMutationArgs(["--since", "HEAD", "--since", "main"])).toHaveProperty("error");
  expect(parseMutationArgs(["--bad"])).toHaveProperty("error");
  expect(parseMutationArgs(["--since", "main", "lib/a.ts"])).toEqual({
    since: "main",
    paths: ["lib/a.ts"],
  });
  expect(parseMutationArgs(["--", "-unit.ts"])).toEqual({ since: undefined, paths: ["-unit.ts"] });
});

test("zero-context hunks select current lines, not removed lines or diff content", () => {
  expect(
    changedRanges(
      "@@ -1 +1 @@\n-a\n+b\n@@ -4,0 +5,3 @@\n+x\n+y\n+z\n@@ -10,2 +12,0 @@\n-old\n-old\n+@@ -1 +50 @@\n",
    ),
  ).toEqual([
    { start: 1, end: 1 },
    { start: 5, end: 7 },
  ]);
});

test("the longest unit stem owns a test, and selection deduplicates normalized paths", async () => {
  for (const [name, source] of Object.entries({
    "lib/name.ts": "export const n = 1;\n",
    "lib/name.detail.ts": "export const n = 2;\n",
    "lib/name.test.ts": "",
    "lib/name.refusal.test.ts": "",
    "lib/name.detail.test.ts": "",
    "other/name.test.ts": "",
  }))
    await Bun.write(path.join(root, name), source);
  const selected = await selectMutationUnits(
    { paths: ["lib/name.refusal.test.ts", "./lib/name.ts"] },
    root,
  );
  expect(selected).toEqual({
    skipped: 0,
    units: [
      {
        name: "lib/name.ts",
        source: "export const n = 1;\n",
        tests: ["./lib/name.refusal.test.ts", "./lib/name.test.ts"],
        patterns: ["lib/name.ts"],
      },
    ],
  });
  const detail = await selectMutationUnits({ paths: ["lib/name.detail.test.ts"] }, root);
  expect(detail).toMatchObject({
    units: [{ name: "lib/name.detail.ts", tests: ["./lib/name.detail.test.ts"] }],
  });
});

test("symlink targets refuse before reading their content", async () => {
  const directory = await mkdtemp(`${root}/link-`);
  await Bun.write(path.join(directory, "actual.ts"), "export const n = 1;\n");
  await symlink(path.join(directory, "actual.ts"), path.join(directory, "linked.ts"));
  expect(await selectMutationUnits({ paths: ["linked.ts"] }, directory)).toEqual({
    error: "Target must not use a symbolic link: linked.ts",
  });
});
