import { afterAll, expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { readMutationReuse, saveMutationReuse } from "./mutation-reuse.ts";
import type { MutationResult } from "./mutation-run.ts";

const root = await mkdtemp(path.join(tmpdir(), "mutation-reuse-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const killed: MutationResult = {
  id: "1",
  status: "Killed",
  mutatorName: "ArithmeticOperator",
  location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
  replacement: "-",
};

test("completed results round-trip without turning surviving or ignored results into killed results", async () => {
  for (const status of ["Killed", "Survived", "NoCoverage", "Ignored"]) {
    const results = [{ ...killed, status }];
    await saveMutationReuse(root, status, results);
    expect(await readMutationReuse(root, status)).toEqual(results);
  }
  await saveMutationReuse(root, "empty", []);
  expect(await readMutationReuse(root, "empty")).toEqual([]);
});

test.each(["Pending", "Timeout", "CompileError", "RuntimeError"])(
  "unfinished %s results never create reusable evidence",
  async (status) => {
    await saveMutationReuse(root, status, [{ ...killed, status }]);
    expect(await readMutationReuse(root, status)).toBeUndefined();
    expect(await Bun.file(`${root}/.mutation-reuse/${status}.json`).exists()).toBe(false);
  },
);

test("missing, truncated, mismatched and corrupted receipts force execution", async () => {
  expect(await readMutationReuse(root, "missing")).toBeUndefined();
  await saveMutationReuse(root, undefined, [killed]);
  expect(await Bun.file(`${root}/.mutation-reuse/undefined.json`).exists()).toBe(false);
  await saveMutationReuse(root, "undefined", [killed]);
  expect(await readMutationReuse(root, undefined)).toBeUndefined();
  const file = `${root}/.mutation-reuse/damaged.json`;
  await Bun.write(file, '{"version":1,');
  expect(await readMutationReuse(root, "damaged")).toBeUndefined();
  await saveMutationReuse(root, "valid", [killed]);
  const text = await Bun.file(`${root}/.mutation-reuse/valid.json`).text();
  await Bun.write(file, text);
  expect(await readMutationReuse(root, "damaged")).toBeUndefined();
  await Bun.write(file, text.replace('"valid"', '"damaged"').replace('"Killed"', '"Survived"'));
  expect(await readMutationReuse(root, "damaged")).toBeUndefined();
  await Bun.write(file, text.replace('"valid"', '"damaged"').replace('"version":1', '"version":2'));
  expect(await readMutationReuse(root, "damaged")).toBeUndefined();
});
