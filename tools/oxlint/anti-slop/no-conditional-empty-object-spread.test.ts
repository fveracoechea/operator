import { expect, test } from "bun:test";
import { lintProject } from "../check.ts";

const check = lintProject();

test("rejects conditional empty-object spreads and accepts direct fields", async () => {
  const invalid = await check(
    "export function options(enabled: boolean) { return { ...(enabled ? { id: 1 } : {}) }; }",
  );
  expect(invalid.codes).toContain("anti-slop(no-conditional-empty-object-spread)");
  const valid = await check(
    "export function options(enabled: boolean) { return { id: enabled ? 1 : undefined }; }",
  );
  expect(valid.codes).toEqual([]);
});
