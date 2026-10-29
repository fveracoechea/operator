import { expect, test } from "bun:test";
import { lintProject } from "../check.ts";

const check = lintProject();

test.each(['Reflect.get({ id: 1 }, "id")', 'Reflect["get"]({ id: 1 }, "id")'])(
  "rejects global property reflection %s",
  async (expression) => {
    expect((await check(`export const value: unknown = ${expression};`)).codes).toContain(
      "anti-slop(no-reflect-get)",
    );
  },
);

test("accepts typed access and a shadowed Reflect binding", async () => {
  const valid = await check(
    "const item = { id: 1 }; export const id = item.id; export function read(Reflect: { get(): number }) { return Reflect.get(); }",
  );
  expect(valid.codes).toEqual([]);
});

test("the finding names the fix topic", async () => {
  expect(
    (await check("export const value: unknown = Reflect.get(String, null, [1]);")).stdout,
  ).toContain(
    "Use typed property access. Parse external data before reading its fields. See lint-fixes/parse-at-the-boundary.md.",
  );
});
