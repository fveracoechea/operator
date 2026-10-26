import { expect, test } from "bun:test";
import { sourceArgs } from "./sources.ts";

test("parses only the delivered source and next commands", () => {
  expect(sourceArgs(["source", "register", "--file", "plan.json", "--json"])).toEqual({
    operation: "register",
    file: "plan.json",
    sourceId: undefined,
  });
  expect(sourceArgs(["source", "show", "--source", "id"])).toEqual({
    operation: "show",
    file: undefined,
    sourceId: "id",
  });
  expect(sourceArgs(["next", "--source", "id", "--json"])).toEqual({
    operation: "next",
    file: undefined,
    sourceId: "id",
  });
  expect(sourceArgs(["next"])).toEqual({ operation: "next", file: undefined, sourceId: undefined });
});
test.each(
  [
    ["source"],
    ["source", "register"],
    ["source", "show"],
    ["source", "register", "--file"],
    ["source", "register", "--file", "--json"],
    ["source", "register", "--file", "a", "--file", "b"],
    ["source", "register", "--source", "id"],
    ["next", "--json", "--json"],
    ["next", "--unknown"],
    ["source", "reset"],
    ["dispatch"],
  ].map((args) => ({ args })),
)("refuses invalid arguments $args", ({ args }) => {
  expect(sourceArgs(args)).toBeNull();
});
