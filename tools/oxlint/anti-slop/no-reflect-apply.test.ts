import { expect, test } from "bun:test";
import { lintProject } from "../check.ts";

const check = lintProject();

test.each(["Reflect.apply(String, null, [1])", 'Reflect["apply"](String, null, [1])'])(
  "rejects reflected calls %s",
  async (expression) => {
    expect((await check(`export const value: unknown = ${expression};`)).codes).toContain(
      "anti-slop(no-reflect-apply)",
    );
  },
);

test("accepts typed calls and a shadowed Reflect binding", async () => {
  const valid = await check(
    "export const id = String(1); export function read(Reflect: { apply(): number }) { return Reflect.apply(); }",
  );
  expect(valid.codes).toEqual([]);
});
