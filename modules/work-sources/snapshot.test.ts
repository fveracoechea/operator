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
  launches: [],
  pullRequests: [],
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

test("a PR open assignment needs its recorded PR, and only PR work past running has one", () => {
  const plan = JSON.stringify({
    trackerKey: "APP-1",
    assignments: [
      {
        key: "change",
        trackerKey: "APP-3",
        instructions: "Change.",
        completion: "pr",
        resources: "worktree",
        branch: "task/3",
        dependencies: [],
      },
    ],
  });
  const pr = {
    sourceId: "one",
    assignment: "change",
    repository: "example/one",
    number: 7,
    url: "https://github.com/example/one/pull/7",
    branch: "task/3",
    associatedAt: "now",
    progress: "{}",
    waitState: "waiting",
    waitAt: "now",
    waitOwnerPid: null,
    waitLeaseAt: null,
    waitStopped: false,
  };
  const launch = {
    id: "launch",
    sourceId: "one",
    assignment: "change",
    attempt: 1,
    state: "running",
    name: "pr-3-change",
    resources: "worktree",
    branch: "task/3",
    host: "opencode",
    model: "m",
    requestedModel: "m",
    reasoningEffort: "medium",
    profile: null,
    release: JSON.stringify({ version: "1" }),
    skills: "[]",
    herdrSocket: null,
    workspaceId: null,
    tabId: null,
    paneId: null,
    worktreePath: null,
    worktreeWorkspaceId: null,
    startedAt: "now",
    endedAt: null,
    failureReason: null,
    failureDetail: null,
    activity: null,
    activityAt: null,
    ownerPid: null,
    leaseAt: null,
    abandoned: false,
  };
  const source = { ...input.source, plan };
  function row(state: string) {
    return [{ sourceId: "one", key: "change", completion: "pr", state }];
  }
  const open = { source, assignments: row("pr-open"), launches: [launch], pullRequests: [pr] };
  expect(decodeSource(open).pullRequests).toEqual([
    {
      assignment: "change",
      number: 7,
      url: pr.url,
      branch: "task/3",
      associatedAt: "now",
      waitState: "waiting",
      waitAt: "now",
      waitStopped: false,
    },
  ]);
  expect(() => decodeSource({ ...open, pullRequests: [] })).toThrow();
  expect(() => decodeSource({ ...open, assignments: row("running") })).toThrow();
  expect(() =>
    decodeSource({ ...open, pullRequests: [{ ...pr, waitState: "unknown" }] }),
  ).toThrow();
  expect(() => decodeSource({ ...open, pullRequests: [{ ...pr, assignment: "other" }] })).toThrow();
});
