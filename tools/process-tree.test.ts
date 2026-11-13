import { expect, test } from "bun:test";
import { descendants } from "./process-tree.ts";

test("finds every process under the root through padded columns", () => {
  const ps = [
    "    1     0",
    "  500     1",
    "99001   500",
    "   12 99001",
    "  700    12",
    "  800   500",
    "",
  ].join("\n");
  expect(descendants(500, ps).toSorted((a, b) => a - b)).toEqual([12, 500, 700, 800, 99001]);
  expect(descendants(12, ps).toSorted((a, b) => a - b)).toEqual([12, 700]);
});

test("a root with no children is only itself, and blank lines add no process", () => {
  expect(descendants(42, "\n   43     1\n\n")).toEqual([42]);
});
