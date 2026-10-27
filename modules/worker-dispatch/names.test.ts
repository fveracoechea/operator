import { expect, test } from "bun:test";
import { chooseNames, launchBase } from "./names.ts";

test("names show the task type, tracker key, and assignment within Herdr's name limit", () => {
  expect(
    launchBase({ completion: "pr", trackerKey: "github:example/one#12", key: "implement" }),
  ).toBe("pr-one-12-implement");
  expect(launchBase({ completion: "report", trackerKey: "APP-7", key: "Read Docs!" })).toBe(
    "report-app-7-read-docs",
  );
  const long = launchBase({
    completion: "report",
    trackerKey: "x".repeat(80),
    key: "y".repeat(80),
  });
  expect(long.length).toBeLessThanOrEqual(28);
  expect(long).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
});

test("collisions in names or branches take the next shared suffix", () => {
  expect(
    chooseNames({
      base: "pr-1",
      branch: "task/1",
      takenNames: new Set(),
      takenBranches: new Set(),
    }),
  ).toEqual({ name: "pr-1", branch: "task/1" });
  expect(
    chooseNames({
      base: "pr-1",
      branch: "task/1",
      takenNames: new Set(["pr-1-2"]),
      takenBranches: new Set(["task/1"]),
    }),
  ).toEqual({ name: "pr-1-3", branch: "task/1-3" });
  expect(
    chooseNames({
      base: "r",
      branch: null,
      takenNames: new Set(["r"]),
      takenBranches: new Set(["r-2"]),
    }),
  ).toEqual({ name: "r-2", branch: null });
  const all = new Set(Array.from({ length: 1000 }, (_, index) => (index < 2 ? "r" : `r-${index}`)));
  expect(
    chooseNames({ base: "r", branch: null, takenNames: all, takenBranches: new Set() }),
  ).toBeNull();
});
