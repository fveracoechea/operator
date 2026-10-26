import { expect, test } from "bun:test";
import { decideSource } from "./source-machine.ts";

test("an empty source and a mixed completed source finish, but active or abandoned work does not", () => {
  expect(decideSource({ state: "open", assignments: [] })).toBe("finished");
  expect(
    decideSource({
      state: "open",
      assignments: [
        { key: "pr", completion: "pr", state: "merged" },
        { key: "report", completion: "report", state: "completed" },
      ],
    }),
  ).toBe("finished");
  for (const state of ["ready", "running", "reported", "abandoned"] as const)
    expect(
      decideSource({
        state: "open",
        assignments: [{ key: "report", completion: "report", state }],
      }),
    ).toBe("open");
  expect(
    decideSource({
      state: "open",
      assignments: [{ key: "pr", completion: "pr", state: "pr-open" }],
    }),
  ).toBe("open");
});
test("ended source states are stable on repeated reads", () => {
  expect(decideSource({ state: "reset", assignments: [] })).toBe("reset");
  expect(decideSource({ state: "finished", assignments: [] })).toBe("finished");
});
