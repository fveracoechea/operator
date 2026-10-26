import { expect, test } from "bun:test";
import { decodeSource } from "./snapshot.ts";

const input = {
  source: {
    id: "one",
    repository: "example/one",
    trackerKey: "APP-1",
    state: "open",
    registeredAt: "now",
    endedAt: null,
    plan: JSON.stringify({
      trackerKey: "APP-1",
      assignments: [
        {
          key: "read",
          trackerKey: "APP-2",
          instructions: "Read.",
          completion: "report",
          resources: "pane",
          dependencies: [],
        },
      ],
    }),
  },
  assignments: [{ sourceId: "one", key: "read", completion: "report", state: "ready" }],
};
test("decodes persisted plans and strips storage-only assignment fields", () => {
  expect(decodeSource(input)).toMatchObject({
    plan: { trackerKey: "APP-1" },
    assignments: [{ key: "read", completion: "report", state: "ready" }],
  });
  expect(decodeSource(input).assignments[0]).not.toHaveProperty("sourceId");
});
test("rejects malformed plans, unknown states, mismatched parents and assignment sets", () => {
  expect(() => decodeSource({ ...input, source: { ...input.source, plan: "broken" } })).toThrow();
  expect(() => decodeSource({ ...input, source: { ...input.source, state: "unknown" } })).toThrow();
  expect(() =>
    decodeSource({ ...input, source: { ...input.source, trackerKey: "other" } }),
  ).toThrow();
  expect(() => decodeSource({ ...input, assignments: [] })).toThrow();
  expect(() =>
    decodeSource({
      ...input,
      assignments: [
        {
          ...input.assignments[0],
          sourceId: "one",
          key: "other",
          completion: "report",
          state: "ready",
        },
      ],
    }),
  ).toThrow();
  expect(() =>
    decodeSource({
      ...input,
      assignments: [{ sourceId: "one", key: "read", completion: "pr", state: "ready" }],
    }),
  ).toThrow();
});

test("source state and end-time invariants reject incomplete or unpersisted transitions", () => {
  const completed = [{ sourceId: "one", key: "read", completion: "report", state: "completed" }];
  expect(() => decodeSource({ ...input, assignments: completed })).toThrow();
  expect(() =>
    decodeSource({ ...input, source: { ...input.source, state: "finished", endedAt: "later" } }),
  ).toThrow();
  expect(() => decodeSource({ ...input, source: { ...input.source, endedAt: "later" } })).toThrow();
  expect(() =>
    decodeSource({ ...input, source: { ...input.source, state: "reset", endedAt: "later" } }),
  ).toThrow();
  expect(
    decodeSource({
      ...input,
      source: { ...input.source, state: "finished", endedAt: "later" },
      assignments: completed,
    }).state,
  ).toBe("finished");
  expect(
    decodeSource({
      ...input,
      source: { ...input.source, state: "reset", endedAt: "later" },
      assignments: [{ sourceId: "one", key: "read", completion: "report", state: "abandoned" }],
    }).state,
  ).toBe("reset");
});
