import { expect, test } from "bun:test";
import { rewriteSpecifiers } from "./specifiers.ts";

test("rewrites static, side-effect, dynamic, and declaration imports without changing bare or JSON imports", () => {
  expect(
    rewriteSpecifiers(`import { a } from "./a.ts";
export { b } from '../b.ts';
import "./side.ts";
const lazy = import('./lazy.ts');
type T = import("./types.ts").T;
import { z } from "zod";
import data from "./data.json";
`),
  ).toBe(`import { a } from "./a.js";
export { b } from '../b.js';
import "./side.js";
const lazy = import('./lazy.js');
type T = import("./types.js").T;
import { z } from "zod";
import data from "./data.json";
`);
});
