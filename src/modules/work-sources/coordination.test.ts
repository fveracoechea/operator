import { expect, test } from "bun:test";
import {
  actionKey,
  actionKeys,
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
const timedOut = { action: "owner_attention", reason: "pr_wait_timed_out", assignment: "c" };
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
  const key = actionKey("s1", timedOut);
  const watch = startWatch();
  const stored = new Set<string>();
  const current = new Set([key]);
  expect(dueKeys({ stored, current, watch, now: 0 })).toEqual([]);
  expect(dueKeys({ stored, current, watch, now: settlingGraceMs - 1 })).toEqual([]);
  expect(dueKeys({ stored, current, watch, now: settlingGraceMs })).toEqual([key]);
});

test("a settling key that cleared within the grace period starts its period again", () => {
  const key = actionKey("s1", timedOut);
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
