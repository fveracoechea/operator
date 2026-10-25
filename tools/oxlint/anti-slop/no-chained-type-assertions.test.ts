import { expect, test } from "bun:test";
import { lintProject } from "../check.ts";

const check = lintProject();

test("rejects assertion chains and accepts a single const assertion", async () => {
  const invalid = await check("export const value = (null as unknown) as { id: string };");
  expect(invalid.codes).toContain("anti-slop(no-chained-type-assertions)");
  const valid = await check('export const value = { id: "1" } as const;');
  expect(valid.codes).toEqual([]);
  expect(valid.exitCode).toBe(0);
});
