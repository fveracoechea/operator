import { expect, test } from "bun:test";
import type { Observation } from "./github.ts";
import { decideWait, mergeConditions } from "./wait-machine.ts";

const empty: { seen: string[]; failures: string[]; eligibleHead: string | null } = {
  seen: [],
  failures: [],
  eligibleHead: null,
};
const open: Observation = {
  state: "OPEN",
  head: "h1",
  mergeCommit: null,
  mergeMethod: "squash",
  base: "main",
  defaultBranch: "main",
  approved: false,
  unresolvedThreads: 0,
  feedback: [],
  checks: [],
};
function item(id: string, change: Record<string, unknown> = {}) {
  return {
    id,
    kind: "comment" as const,
    author: "reviewer",
    fromViewer: false,
    operatorReview: false,
    body: "Check this.",
    url: `https://github.com/${id}`,
    reviewState: null,
    path: null,
    threadResolved: null,
    ...change,
  };
}

test("nothing new decides nothing and changes no progress", () => {
  expect(decideWait({ progress: empty, observed: open })).toEqual({ result: "none" });
  expect(
    decideWait({
      progress: { seen: ["a"], failures: ["h1:lint"], eligibleHead: null },
      observed: {
        ...open,
        feedback: [item("a")],
        checks: [{ name: "lint", state: "failing", url: null }],
      },
    }),
  ).toEqual({ result: "none" });
});

test("new feedback is reported once and an empty commented review only holds inline comments", () => {
  const observed = {
    ...open,
    feedback: [
      item("a"),
      item("b", { kind: "review", body: "", reviewState: "COMMENTED" }),
      item("c", { kind: "review", body: "", reviewState: "APPROVED" }),
      item("d", { kind: "review", body: "Text.", reviewState: "COMMENTED" }),
    ],
  };
  const decision = decideWait({ progress: empty, observed });
  expect(decision).toEqual({
    result: "reported",
    events: [
      {
        kind: "feedback",
        items: observed.feedback.filter((entry) => entry.id !== "b"),
      },
    ],
    progress: { seen: ["a", "c", "d"], failures: [], eligibleHead: null },
  });
  if (decision.result !== "reported") return;
  expect(decideWait({ progress: decision.progress, observed })).toEqual({ result: "none" });
});

test("a failing check is reported once per head, and pending or passing checks are not", () => {
  const checks = [
    { name: "lint", state: "failing" as const, url: null },
    { name: "test", state: "pending" as const, url: null },
    { name: "types", state: "passing" as const, url: null },
  ];
  const first = decideWait({ progress: empty, observed: { ...open, checks } });
  expect(first).toEqual({
    result: "reported",
    events: [{ kind: "checks_failed", head: "h1", checks: checks.slice(0, 1) }],
    progress: { seen: [], failures: ["h1:lint"], eligibleHead: null },
  });
  if (first.result !== "reported") return;
  expect(decideWait({ progress: first.progress, observed: { ...open, checks } })).toEqual({
    result: "none",
  });
  expect(
    decideWait({ progress: first.progress, observed: { ...open, head: "h2", checks } }),
  ).toMatchObject({ events: [{ kind: "checks_failed", head: "h2" }] });
});

test("eligibility needs all five merge conditions and is reported once per head", () => {
  const eligible = {
    ...open,
    approved: true,
    checks: [{ name: "ci", state: "passing" as const, url: null }],
  };
  expect(mergeConditions(eligible)).toEqual({
    approved: true,
    checksPassing: true,
    threadsResolved: true,
    defaultBase: true,
    stackRelayed: true,
  });
  // A stacked PR whose relay has not finished is not eligible, even on the default branch.
  expect(mergeConditions(eligible, false)).toMatchObject({
    defaultBase: true,
    stackRelayed: false,
  });
  expect(decideWait({ progress: empty, observed: eligible, stackRelayed: false })).toEqual({
    result: "none",
  });
  for (const blocked of [
    { ...eligible, approved: false },
    { ...eligible, unresolvedThreads: 1 },
    { ...eligible, base: "parent" },
    { ...eligible, defaultBranch: null },
    { ...eligible, checks: [{ name: "ci", state: "pending" as const, url: null }] },
    { ...eligible, checks: [] },
  ])
    expect(decideWait({ progress: empty, observed: blocked })).toEqual({ result: "none" });
  const first = decideWait({ progress: empty, observed: eligible });
  expect(first).toEqual({
    result: "reported",
    events: [{ kind: "merge_eligible", head: "h1" }],
    progress: { seen: [], failures: [], eligibleHead: "h1" },
  });
  if (first.result !== "reported") return;
  expect(decideWait({ progress: first.progress, observed: eligible })).toEqual({ result: "none" });
  expect(
    decideWait({ progress: first.progress, observed: { ...eligible, head: "h2" } }),
  ).toMatchObject({ events: [{ kind: "merge_eligible", head: "h2" }] });
});

test("a merged or closed PR ends the wait first and keeps progress", () => {
  const progress = { seen: ["a"], failures: [], eligibleHead: "h1" };
  expect(
    decideWait({ progress, observed: { ...open, state: "MERGED", feedback: [item("b")] } }),
  ).toEqual({ result: "not_open", events: [{ kind: "pr_merged" }], progress });
  expect(decideWait({ progress, observed: { ...open, state: "CLOSED" } })).toEqual({
    result: "not_open",
    events: [{ kind: "pr_closed" }],
    progress,
  });
});

test("the same facts give the same decision and the input progress is not changed", () => {
  const progress = empty;
  const observed = { ...open, feedback: [item("a")] };
  const before = structuredClone(progress);
  expect(decideWait({ progress, observed })).toEqual(decideWait({ progress, observed }));
  expect(progress).toEqual(before);
});

test("an Operator review from the owner's account ends a wait alone", () => {
  const review = item("review", {
    kind: "review",
    fromViewer: true,
    operatorReview: true,
    reviewState: "COMMENTED",
    body: "No blockers.",
  });
  expect(decideWait({ progress: empty, observed: { ...open, feedback: [review] } })).toEqual({
    result: "reported",
    events: [{ kind: "feedback", items: [review] }],
    progress: { seen: ["review"], failures: [], eligibleHead: null },
  });
});

test("the owner's own items never end a wait alone and are reported with the next event", () => {
  const own = item("own", { fromViewer: true, author: "owner" });
  expect(decideWait({ progress: empty, observed: { ...open, feedback: [own] } })).toEqual({
    result: "none",
  });
  const other = item("other");
  expect(decideWait({ progress: empty, observed: { ...open, feedback: [own, other] } })).toEqual({
    result: "reported",
    events: [{ kind: "feedback", items: [own, other] }],
    progress: { seen: ["own", "other"], failures: [], eligibleHead: null },
  });
  expect(
    decideWait({
      progress: empty,
      observed: { ...open, feedback: [own], checks: [{ name: "ci", state: "failing", url: null }] },
    }),
  ).toMatchObject({ events: [{ kind: "feedback", items: [own] }, { kind: "checks_failed" }] });
});
