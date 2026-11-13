import { expect, test } from "bun:test";
import { slug } from "./slug.ts";

test("keeps only lowercase letters and digits joined by single hyphens", () => {
  expect(slug("Operator")).toBe("operator");
  expect(slug("--Fix  the_CLI #258!--")).toBe("fix-the-cli-258");
  expect(slug("a.b/c")).toBe("a-b-c");
  expect(slug("Ünïcode ok")).toBe("n-code-ok");
  expect(slug("---")).toBe("");
  expect(slug("")).toBe("");
});
