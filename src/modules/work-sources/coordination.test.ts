import { expect, test } from "bun:test";
import {
  actionKey,
  actionKeys,
  eventKey,
  addKeys,
  changedAnswer,
  dropKeys,
  dueKeys,
  parseKey,
  parseSet,
  settlingGraceMs,
  startWatch,
} from "./coordination.ts";

const ready = { action: "ready_assignment", reason: "dependencies_met", assignment: "b" };
const report = { action: "review_report", reason: "report_submitted", assignment: "a" };
const idle = { action: "worker_attention", reason: "worker_idle", assignment: "c" };
function question(key: string) {
  return { action: "answer_question", reason: "question_open", assignment: "a", question: { key } };
}

function answer(...sources: [string, object[]][]) {
  return {
    sources: sources.map(([id, actions]) => ({
      id,
      state: "open",
      actions: actions as { action: string; reason?: string; assignment?: string }[],
      waits: [{ action: "wait" }],
    })),
  };
}

test("a key names the source, assignment, action, reason, and the question or message it names", () => {
  expect(JSON.parse(actionKey("s1", ready))).toEqual([
    "s1",
    "b",
    "ready_assignment",
    "dependencies_met",
  ]);
  expect(JSON.parse(actionKey("s1", { action: "prune_source" }))).toEqual([
    "s1",
    null,
    "prune_source",
    null,
  ]);
  expect(JSON.parse(actionKey("s1", question("q1")))).toEqual([
    "s1",
    "a",
    "answer_question",
    "question_open",
    "q1",
  ]);
  const message = { action: "read_reply", reason: "message_replied", message: { key: "m1" } };
  expect(parseKey(actionKey("s1", message))[4]).toBe("m1");
});

test("recorded facts beside an action leave its key unchanged, and a second question is a new key", () => {
  expect(actionKey("s1", { ...ready, launch: { state: "idle" } } as typeof ready)).toBe(
    actionKey("s1", ready),
  );
  expect(actionKeys(answer(["s1", [question("q1"), question("q2"), ready, ready]])).size).toBe(3);
});

test("a stored set reads as keys, also a set of tuples from an earlier release", () => {
  expect(parseSet(null)).toBeNull();
  expect(() => parseSet("{}")).toThrow();
  const key = actionKey("s1", ready);
  expect(parseSet(JSON.stringify([key]))).toEqual(new Set([key]));
  expect(parseSet(JSON.stringify([JSON.parse(key)]))).toEqual(new Set([key]));
});

test("keys are added to or dropped from a stored set in a fixed order", () => {
  expect(addKeys(["b", "a"])(null)).toBe('["a","b"]');
  expect(addKeys(["c", "a"])('["b","a"]')).toBe('["a","b","c"]');
  expect(dropKeys(["b"])('["c","b","a"]')).toBe('["a","c"]');
  expect(dropKeys(["b"])(null)).toBe("[]");
});

test("keys that changed between two waits are due at the first read, and stored keys never are", () => {
  const watch = startWatch();
  const stored = actionKeys(answer(["s1", [report]]));
  const current = actionKeys(answer(["s1", [report, ready]]));
  expect(dueKeys({ stored, current, watch, now: 0 })).toEqual([actionKey("s1", ready)]);
  expect(dueKeys({ stored: current, current, watch, now: 1 })).toEqual([]);
});

test("a key that appears during the wait is due from its second read", () => {
  const watch = startWatch();
  const stored = new Set<string>();
  expect(dueKeys({ stored, current: new Set(), watch, now: 0 })).toEqual([]);
  const current = new Set([actionKey("s1", ready)]);
  expect(dueKeys({ stored, current, watch, now: 1 })).toEqual([]);
  expect(dueKeys({ stored, current, watch, now: 2 })).toEqual([...current]);
  // An acknowledgement between the two reads stores the key, so it never wakes the wait.
  const acknowledged = startWatch();
  dueKeys({ stored, current: new Set(), watch: acknowledged, now: 0 });
  dueKeys({ stored, current, watch: acknowledged, now: 1 });
  expect(dueKeys({ stored: current, current, watch: acknowledged, now: 2 })).toEqual([]);
});

test("a removed key wakes nobody", () => {
  const watch = startWatch();
  const stored = actionKeys(answer(["s1", [report, ready]]));
  expect(dueKeys({ stored, current: new Set(), watch, now: 0 })).toEqual([]);
});

test("a settling key is due only once it lasted the grace period, also between two waits", () => {
  const key = actionKey("s1", idle);
  const watch = startWatch();
  const stored = new Set<string>();
  const current = new Set([key]);
  expect(dueKeys({ stored, current, watch, now: 0 })).toEqual([]);
  expect(dueKeys({ stored, current, watch, now: settlingGraceMs - 1 })).toEqual([]);
  expect(dueKeys({ stored, current, watch, now: settlingGraceMs })).toEqual([key]);
});

test("a settling key that cleared within the grace period starts its period again", () => {
  const key = actionKey("s1", idle);
  const watch = startWatch();
  const stored = new Set<string>();
  dueKeys({ stored, current: new Set([key]), watch, now: 0 });
  dueKeys({ stored, current: new Set(), watch, now: 1000 });
  expect(dueKeys({ stored, current: new Set([key]), watch, now: settlingGraceMs })).toEqual([]);
  expect(dueKeys({ stored, current: new Set([key]), watch, now: 2 * settlingGraceMs })).toEqual([
    key,
  ]);
});

test("a changed answer keeps only the given actions, drops waits, and drops sources without one", () => {
  const full = answer(["s1", [report, ready]], ["s2", [report]]);
  expect(changedAnswer(full, new Set([actionKey("s1", ready)]))).toEqual({
    sources: [{ id: "s1", state: "open", actions: [ready] }],
  });
  expect(changedAnswer(full, new Set())).toEqual({ sources: [] });
});

test("review actions and events add distinct keys, but quiet review waits add none", () => {
  expect([
    ...actionKeys({
      sources: [],
      requests: [
        { url: "pr/7", action: "start_reviewer", reason: "review_queued" },
        { url: "pr/8", action: "wait_reviews", reason: "reviewer_move_unfinished" },
        { url: "pr/9", attention: "reviewer_work_kept" },
        { url: "pr/10" },
      ],
      events: [{ url: "pr/7", kind: "read_failed", reason: "github_uncertain", detail: "outage" }],
    }),
  ]).toEqual([
    '["review:pr/7",null,"start_reviewer","review_queued"]',
    '["review:pr/9",null,"review_attention","reviewer_work_kept"]',
    '["review:pr/7",null,"review_event","read_failed","github_uncertain"]',
  ]);
});

test("a changed review answer retains only new events and their named or newly actionable rows", () => {
  const first = { url: "pr/7", action: "start_reviewer", reason: "review_queued" };
  const moved = { url: "pr/8", wait: "review_draft" };
  const unrelated = { url: "pr/9", action: "post_review", reason: "review_post_uncertain" };
  const event = { url: "pr/8", kind: "head_moved", from: "head-one", to: "head-two" };
  const oldEvent = { url: "pr/9", kind: "head_moved", from: "head-zero", to: "head-one" };
  expect(eventKey(event)).toBe(
    '["review:pr/8",null,"review_event","head_moved","{\\"url\\":\\"pr/8\\",\\"kind\\":\\"head_moved\\",\\"from\\":\\"head-one\\",\\"to\\":\\"head-two\\"}"]',
  );
  expect(
    changedAnswer(
      { sources: [], requests: [first, moved, unrelated], events: [oldEvent, event] },
      new Set(['["review:pr/7",null,"start_reviewer","review_queued"]', eventKey(event)]),
    ),
  ).toEqual({ sources: [], requests: [first, moved], events: [event] });
  expect(changedAnswer({ sources: [], requests: [first] }, new Set())).toEqual({
    sources: [],
    requests: [],
    events: [],
  });
});

test("different diagnostics for the same failed review read keep its acknowledged key", () => {
  expect(
    eventKey({
      url: "pr/7",
      kind: "read_failed",
      reason: "github_uncertain",
      detail: "second outage message",
    }),
  ).toBe('["review:pr/7",null,"review_event","read_failed","github_uncertain"]');
});

test.each([
  ["owner_attention", "pr_owner_idle", "worker_attention", "worker_idle"],
  ["resume_worker", "follow_up_returned", "worker_attention", "follow_up_returned"],
  ["retry_cleanup", "cleanup_failed", "clean_up", "cleanup_failed"],
  ["retry_cleanup", "cleanup_stopped", "clean_up", "cleanup_stopped"],
  ["retry_cleanup", "cleanup_unfinished", "clean_up", "cleanup_stopped"],
  ["retry_handoff", "handoff_failed", "replace_worker", "handoff_failed"],
  ["owner_attention", "pr_wait_stopped", "replace_worker", "worker_interrupted"],
])(
  "%s/%s returns once under its renamed action key without migrating stored keys",
  (oldAction, oldReason, action, reason) => {
    const stored = new Set([
      actionKey("s1", { assignment: "a", action: oldAction, reason: oldReason }),
    ]);
    const key = actionKey("s1", { assignment: "a", action, reason });
    const current = new Set([key]);
    const watch = startWatch();
    dueKeys({ stored, current, watch, now: 0 });
    expect(dueKeys({ stored, current, watch, now: settlingGraceMs })).toEqual([key]);
    expect(
      dueKeys({ stored: current, current, watch: startWatch(), now: 2 * settlingGraceMs }),
    ).toEqual([]);
  },
);
