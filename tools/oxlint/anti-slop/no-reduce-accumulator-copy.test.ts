import { expect, test } from "bun:test";
import { lintProject } from "../check.ts";

const check = lintProject();

test.each([
  "[1].reduce<number[]>((acc, item) => acc.concat([item]), [])",
  "[1].reduce<number[]>((acc) => Array.from(acc), [])",
  "[1].reduce<number[]>((acc, item) => { const alias = acc; return alias.concat([item]); }, [])",
  "[1].reduce((acc, item) => { const alias = acc; return alias.concat([item]); }, [1].map(Number))",
  "[1].reduce<Record<string, number>>((acc, item) => Object.assign({}, acc, { item }), {})",
])("rejects accumulator copy %s", async (expression) => {
  expect((await check(`export const value = ${expression};`)).codes).toContain(
    "anti-slop(no-reduce-accumulator-copy)",
  );
});

test("accepts an owned mutable accumulator and does not follow reassigned arrays", async () => {
  const valid = await check(`
export const value = [1].reduce<number[]>((acc, item) => { acc.push(item); return acc; }, []);
let initial: number[] = [1]; initial = [2];
export const copied = [1].reduce((acc, item) => acc.concat([item]), initial);
`);
  expect(valid.codes).toEqual([]);
});
