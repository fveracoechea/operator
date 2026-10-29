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

test("the finding names the fix topic", async () => {
  const invalid = await check(
    "export function options(enabled: boolean) { return { ...(enabled ? { id: 1 } : {}) }; }",
  );
  expect(invalid.stdout).toContain(
    "This conditional spread hides property omission behind an empty object. Build the object in separate statements and add the property only when present. See lint-fixes/object-construction.md.",
  );
});
