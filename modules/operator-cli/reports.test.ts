import { expect, test } from "bun:test";
import { reportArgs } from "./reports.ts";

test("worker commands take no assignment selector, and SuperAgent commands name one", () => {
  expect(reportArgs(["report", "submit", "--file", "r.json", "--json"])).toEqual({
    command: "submit",
    file: "r.json",
    sourceId: "",
    assignment: "",
  });
  expect(reportArgs(["report", "resume"])).toMatchObject({ command: "resume" });
  expect(reportArgs(["report", "accept", "--source", "s", "--assignment", "a"])).toMatchObject({
    command: "accept",
    sourceId: "s",
    assignment: "a",
  });
  expect(
    reportArgs(["report", "return", "--assignment", "a", "--file", "f.md", "--source", "s"]),
  ).toMatchObject({ command: "return", sourceId: "s", assignment: "a", file: "f.md" });
  for (const args of [
    ["report"],
    ["report", "complete"],
    ["report", "submit"],
    ["report", "submit", "--file", "r.json", "--source", "s"],
    ["report", "resume", "--assignment", "a"],
    ["report", "accept", "--source", "s"],
    ["report", "accept", "--source", "s", "--source", "t", "--assignment", "a"],
    ["report", "return", "--source", "s", "--assignment", "a"],
    ["report", "submit", "--file", "--json"],
    ["report", "resume", "--json", "--json"],
  ])
    expect(reportArgs(args)).toBeNull();
});
