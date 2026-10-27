import { expect, test } from "bun:test";
import { sourceArgs } from "./sources.ts";

test("parses only the delivered source and next commands", () => {
  expect(sourceArgs(["source", "register", "--file", "plan.json", "--json"])).toEqual({
    operation: "register",
    file: "plan.json",
    sourceId: undefined,
    personInstructed: false,
  });
  expect(sourceArgs(["source", "show", "--source", "id"])).toEqual({
    operation: "show",
    file: undefined,
    sourceId: "id",
    personInstructed: false,
  });
  expect(sourceArgs(["next", "--source", "id", "--json"])).toEqual({
    operation: "next",
    file: undefined,
    sourceId: "id",
    personInstructed: false,
  });
  expect(sourceArgs(["next"])).toEqual({
    operation: "next",
    file: undefined,
    sourceId: undefined,
    personInstructed: false,
  });
  expect(sourceArgs(["source", "reset", "--person-instructed", "--source", "id"])).toEqual({
    operation: "reset",
    file: undefined,
    sourceId: "id",
    personInstructed: true,
  });
  // A missing instruction is parsed, so the operation refuses with its own reason.
  expect(sourceArgs(["source", "reset", "--source", "id"])).toMatchObject({
    operation: "reset",
    personInstructed: false,
  });
  expect(sourceArgs(["source", "prune", "--json"])).toEqual({
    operation: "prune",
    file: undefined,
    sourceId: undefined,
    personInstructed: false,
  });
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
    ["source", "register", "--file", "a", "--person-instructed"],
    ["next", "--json", "--json"],
    ["next", "--unknown"],
    ["next", "--person-instructed"],
    ["source", "reset"],
    ["source", "reset", "--person-instructed"],
    ["source", "reset", "--source", "id", "--person-instructed", "--person-instructed"],
    ["source", "prune", "--source", "id"],
    ["source", "prune", "--person-instructed"],
    ["source", "archive"],
    ["dispatch"],
  ].map((args) => ({ args })),
)("refuses invalid arguments $args", ({ args }) => {
  expect(sourceArgs(args)).toBeNull();
});
