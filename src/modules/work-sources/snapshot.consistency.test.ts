import { expect, test } from "bun:test";
import { z } from "zod";
import { decodeSource } from "./snapshot.ts";
import {
  storedCleanup,
  storedLaunch,
  storedPullRequest,
  storedReport,
  storedSource,
} from "./source-fixture.ts";

const corrupt = new z.ZodError([
  { code: "custom", path: [], message: "Source rows do not match the supplied plan." },
]);
const merged = { mergedHead: "abc", mergeCommit: "def", mergedAt: "2026-01-05T00:00:00.000Z" };

/** A valid open source with every stored variant of each record. */
const full = storedSource(
  [
    { key: "run", completion: "report", state: "running" },
    { key: "ret", completion: "report", state: "reported" },
    { key: "pend", completion: "report", state: "completed" },
    { key: "fail", completion: "report", state: "completed" },
    { key: "p1", completion: "pr", state: "pr-open" },
    { key: "p2", completion: "pr", state: "pr-open" },
    { key: "p3", completion: "pr", state: "pr-open" },
    { key: "gone", completion: "pr", state: "abandoned" },
    { key: "m1", completion: "pr", state: "merged" },
    { key: "m2", completion: "pr", state: "merged" },
    { key: "m3", completion: "pr", state: "merged" },
    { key: "later", completion: "pr", state: "ready" },
  ],
  {
    launches: [
      storedLaunch("run", { id: "run-1", attempt: 1, state: "failed" }),
      storedLaunch("run", { id: "run-2", attempt: 2, state: "interrupted" }),
      storedLaunch("run", { id: "run-3", attempt: 3, state: "starting", abandoned: true }),
      storedLaunch("ret", {
        host: "claude-code",
        release: JSON.stringify({ version: "2.0.0", channel: "beta" }),
        skills: JSON.stringify([{ name: "review", identity: "sha256:1" }]),
      }),
      storedLaunch("pend", { state: "finished" }),
      storedLaunch("fail", { state: "finished" }),
      ...["p1", "p2", "p3", "gone", "m1", "m2", "m3"].map((key) => storedLaunch(key)),
    ],
    pullRequests: [
      storedPullRequest("p1", {
        relay: JSON.stringify({
          parent: { assignment: "m1", number: 3, branch: "task/m1" },
          state: "stacked",
          blocker: null,
        }),
      }),
      storedPullRequest("p2", {
        waitState: "timed_out",
        relay: JSON.stringify({
          parent: { assignment: "m1", number: 3, branch: "task/m1" },
          state: "blocked",
          blocker: { reason: "relay_conflict", detail: "A conflict." },
        }),
      }),
      storedPullRequest("p3", {
        waitState: "not_open",
        relay: JSON.stringify({
          parent: { assignment: "m1", number: 3, branch: "task/m1" },
          state: "relayed",
          blocker: null,
        }),
      }),
      storedPullRequest("gone"),
      ...["m1", "m2", "m3"].map((key) => storedPullRequest(key, merged)),
    ],
    reports: [
      storedReport("ret", {
        decisions: JSON.stringify([{ question: "Name?", answer: "reader", by: "super-agent" }]),
        decision: "returned",
        decidedAt: "2026-01-04T00:00:00.000Z",
        followUp: "Again.",
      }),
      storedReport("pend", { decision: "accepted", cleanupState: "pending" }),
      storedReport("fail", { decision: "accepted", cleanupState: "failed" }),
    ],
    cleanups: [
      storedCleanup("m1", { step: "remote_branch", state: "pending" }),
      storedCleanup("m2", { step: "worktree", state: "blocked", reason: "cleanup_unlanded_work" }),
      storedCleanup("m3"),
    ],
  },
);

test("every stored variant decodes, and assignments follow the plan order", () => {
  const source = decodeSource(full);
  expect<unknown>(source.assignments).toEqual(
    full.assignments.map(({ key, completion, state }) => ({ key, completion, state })),
  );
  expect<unknown>(
    source.launches.map((row) => [row.id, row.state, row.host, row.abandoned]),
  ).toEqual([
    ["run-1", "failed", "opencode", false],
    ["run-2", "interrupted", "opencode", false],
    ["run-3", "starting", "opencode", true],
    ["l-ret", "running", "claude-code", false],
    ["l-pend", "finished", "opencode", false],
    ["l-fail", "finished", "opencode", false],
    ...["p1", "p2", "p3", "gone", "m1", "m2", "m3"].map((key) => [
      `l-${key}`,
      "running",
      "opencode",
      false,
    ]),
  ]);
  expect(source.launches[3]?.release).toEqual({ version: "2.0.0", channel: "beta" });
  expect(source.launches[3]?.skills).toEqual([{ name: "review", identity: "sha256:1" }]);
  expect(source.launches[0]?.release).toEqual({ version: "1.0.0" });
  expect(source.pullRequests.map((row) => [row.assignment, row.waitState, row.relay])).toEqual([
    [
      "p1",
      "idle",
      {
        parent: { assignment: "m1", number: 3, branch: "task/m1" },
        state: "stacked",
        blocker: null,
      },
    ],
    [
      "p2",
      "timed_out",
      {
        parent: { assignment: "m1", number: 3, branch: "task/m1" },
        state: "blocked",
        blocker: { reason: "relay_conflict", detail: "A conflict." },
      },
    ],
    [
      "p3",
      "not_open",
      {
        parent: { assignment: "m1", number: 3, branch: "task/m1" },
        state: "relayed",
        blocker: null,
      },
    ],
    ["gone", "idle", null],
    ["m1", "idle", null],
    ["m2", "idle", null],
    ["m3", "idle", null],
  ]);
  expect(source.reports.map((row) => [row.assignment, row.decision, row.cleanupState])).toEqual([
    ["ret", "returned", null],
    ["pend", "accepted", "pending"],
    ["fail", "accepted", "failed"],
  ]);
  expect(source.reports[0]?.decisions).toEqual([
    { question: "Name?", answer: "reader", by: "super-agent" },
  ]);
  expect(source.cleanups.map((row) => [row.assignment, row.step, row.state])).toEqual([
    ["m1", "remote_branch", "pending"],
    ["m2", "worktree", "blocked"],
    ["m3", null, "done"],
  ]);
});

test("malformed stored values are refused", () => {
  for (const change of [
    {
      launches: [
        ...full.launches,
        storedLaunch("run", { id: "run-4", attempt: 4, release: JSON.stringify({ name: "x" }) }),
      ],
    },
    {
      launches: [
        ...full.launches,
        storedLaunch("run", { id: "run-4", attempt: 4, skills: JSON.stringify([{ name: "x" }]) }),
      ],
    },
    {
      pullRequests: [
        ...full.pullRequests.slice(1),
        storedPullRequest("p1", { relay: JSON.stringify({ state: "stacked", blocker: null }) }),
      ],
    },
    {
      pullRequests: [
        ...full.pullRequests.slice(1),
        storedPullRequest("p1", {
          relay: JSON.stringify({
            parent: { assignment: "m1" },
            state: "stacked",
            blocker: null,
          }),
        }),
      ],
    },
    {
      pullRequests: [
        ...full.pullRequests.slice(1),
        storedPullRequest("p1", {
          relay: JSON.stringify({
            parent: { assignment: "m1", number: 3, branch: "task/m1" },
            state: "stacked",
            blocker: { reason: "x" },
          }),
        }),
      ],
    },
  ])
    expect(() => decodeSource({ ...full, ...change })).toThrow(z.ZodError);
});

test("the stored assignment set must match the plan", () => {
  const two = storedSource([
    { key: "a", completion: "report", state: "ready" },
    { key: "b", completion: "report", state: "ready" },
  ]);
  expect(decodeSource(two).assignments).toEqual([
    { key: "a", completion: "report", state: "ready" },
    { key: "b", completion: "report", state: "ready" },
  ]);
  for (const assignments of [
    [...two.assignments, { sourceId: "one", key: "c", completion: "report", state: "ready" }],
    [two.assignments[0], { sourceId: "one", key: "b", completion: "pr", state: "ready" }],
    [two.assignments[0], { sourceId: "one", key: "c", completion: "report", state: "ready" }],
  ])
    expect(() =>
      decodeSource({ ...two, assignments: assignments.filter((row) => row !== undefined) }),
    ).toThrow(corrupt);
});

test("an ended source needs its end time and only ended work", () => {
  const done = storedSource([{ key: "a", completion: "report", state: "completed" }], {
    state: "finished",
    endedAt: null,
  });
  expect(() => decodeSource(done)).toThrow(corrupt);
  const running = storedSource([{ key: "a", completion: "report", state: "running" }], {
    state: "finished",
    endedAt: "2026-01-09T00:00:00.000Z",
  });
  expect(() => decodeSource(running)).toThrow(corrupt);
  const reset = storedSource(
    [
      { key: "a", completion: "pr", state: "merged" },
      { key: "b", completion: "report", state: "completed" },
      { key: "c", completion: "report", state: "abandoned" },
    ],
    {
      state: "reset",
      endedAt: "2026-01-09T00:00:00.000Z",
      launches: [storedLaunch("a")],
      pullRequests: [storedPullRequest("a", merged)],
      cleanups: [storedCleanup("a")],
    },
  );
  expect(decodeSource(reset).state).toBe("reset");
  for (const key of ["a", "b"]) {
    const only = storedSource(
      reset.assignments
        .filter((row) => row.key === key)
        .map((row) => ({
          key: row.key,
          completion: row.completion === "pr" ? ("pr" as const) : ("report" as const),
          state: row.state,
        })),
      {
        state: "reset",
        endedAt: "2026-01-09T00:00:00.000Z",
        launches: key === "a" ? reset.launches : [],
        pullRequests: key === "a" ? reset.pullRequests : [],
        cleanups: key === "a" ? reset.cleanups : [],
      },
    );
    expect(decodeSource(only).state).toBe("reset");
  }
  expect(() =>
    decodeSource({
      ...reset,
      assignments: [
        ...reset.assignments.slice(0, 2),
        { sourceId: "one", key: "c", completion: "report", state: "running" },
      ],
    }),
  ).toThrow(corrupt);
});

test("a launch belongs to a started assignment", () => {
  const rows = [
    { key: "a", completion: "report" as const, state: "ready" },
    { key: "b", completion: "report" as const, state: "running" },
  ];
  expect(decodeSource(storedSource(rows, { launches: [storedLaunch("b")] })).launches).toHaveLength(
    1,
  );
  expect(() => decodeSource(storedSource(rows, { launches: [storedLaunch("a")] }))).toThrow(
    corrupt,
  );
  expect(() => decodeSource(storedSource(rows, { launches: [storedLaunch("c")] }))).toThrow(
    corrupt,
  );
});

test("a PR belongs to PR work past running, and open PR work has its PR", () => {
  const rows = [
    { key: "a", completion: "pr" as const, state: "pr-open" },
    { key: "b", completion: "pr" as const, state: "pr-open" },
    { key: "c", completion: "pr" as const, state: "ready" },
    { key: "d", completion: "report" as const, state: "running" },
    { key: "e", completion: "report" as const, state: "abandoned" },
  ];
  const launches = ["a", "b", "d"].map((key) => storedLaunch(key));
  const valid = storedSource(rows, {
    launches,
    pullRequests: [storedPullRequest("a"), storedPullRequest("b")],
  });
  expect(decodeSource(valid).pullRequests).toHaveLength(2);
  for (const pullRequests of [
    [storedPullRequest("a")],
    [storedPullRequest("a"), storedPullRequest("b"), storedPullRequest("c")],
    [storedPullRequest("a"), storedPullRequest("b"), storedPullRequest("d")],
    [storedPullRequest("a"), storedPullRequest("b"), storedPullRequest("e")],
    // A verified merge needs the merged state and its cleanup.
    [storedPullRequest("a", merged), storedPullRequest("b")],
  ])
    expect(() => decodeSource({ ...valid, pullRequests })).toThrow(corrupt);
  // Open PR work with a cleanup but no merge is corrupt too.
  expect(() => decodeSource({ ...valid, cleanups: [storedCleanup("a")] })).toThrow(corrupt);
});

test("merged PR work needs its merge and cleanup, and a cleanup names known work", () => {
  const rows = [
    { key: "a", completion: "pr" as const, state: "merged" },
    { key: "b", completion: "pr" as const, state: "pr-open" },
    { key: "c", completion: "report" as const, state: "ready" },
  ];
  const valid = storedSource(rows, {
    launches: [storedLaunch("a"), storedLaunch("b")],
    pullRequests: [storedPullRequest("a", merged), storedPullRequest("b")],
    cleanups: [storedCleanup("a")],
  });
  expect(decodeSource(valid).cleanups).toHaveLength(1);
  for (const change of [
    { pullRequests: [storedPullRequest("a"), storedPullRequest("b")] },
    { cleanups: [] },
    { cleanups: [storedCleanup("a"), storedCleanup("x")] },
    { cleanups: [storedCleanup("a", { state: "pending" })] },
    { cleanups: [storedCleanup("a", { step: "pane" })] },
  ])
    expect(() => decodeSource({ ...valid, ...change })).toThrow(corrupt);
});

test("a report belongs to report work and one of its own launches", () => {
  const rows = [
    { key: "a", completion: "report" as const, state: "reported" },
    { key: "b", completion: "report" as const, state: "reported" },
    { key: "p", completion: "pr" as const, state: "running" },
  ];
  const valid = storedSource(rows, {
    launches: ["a", "b", "p"].map((key) => storedLaunch(key)),
    reports: [storedReport("a"), storedReport("b")],
  });
  expect(decodeSource(valid).reports).toHaveLength(2);
  for (const reports of [
    [storedReport("a"), storedReport("p")],
    [storedReport("a"), storedReport("b", { launchId: "l-a" })],
  ])
    expect(() => decodeSource({ ...valid, reports })).toThrow(corrupt);
});
