import { expect, test } from "bun:test";
import { parse } from "@babel/parser";
import { fakeGithubScript } from "./github-fixture.ts";

test("the paginated GitHub wire fixture is a valid executable script", () => {
  expect(() =>
    parse(fakeGithubScript("/tmp/opencode/issue390-wire-fixture"), { sourceType: "module" }),
  ).not.toThrow();
});
