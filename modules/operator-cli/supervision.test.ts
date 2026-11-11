import { expect, test } from "bun:test";
import { coordinatedSource } from "./supervision.ts";

test("the SuperAgent commands that coordinate a source name their operation and source", () => {
  for (const [args, operation] of [
    [["dispatch", "--source", "s1", "--assignment", "a"], "dispatch"],
    [["next", "--wait", "--source", "s1"], "next_wait"],
    [["report", "accept", "--source", "s1", "--assignment", "a"], "report_accept"],
    [["report", "return", "--source", "s1"], "report_return"],
    [["question", "escalate", "--source", "s1"], "question_escalate"],
    [["question", "answer", "--source", "s1"], "question_answer"],
    [["message", "send", "--source", "s1"], "message_send"],
    [["message", "ring", "--source", "s1"], "message_ring"],
    [["message", "close", "--source", "s1"], "message_close"],
    [["cleanup", "--source", "s1", "--assignment", "a"], "cleanup"],
    [["handoff", "--source", "s1", "--assignment", "a"], "handoff"],
  ] as const)
    expect(coordinatedSource([...args, "--json"])).toEqual({ operation, sourceId: "s1" });
});

test("reads, worker commands, unscoped waits, and the person's instructions are not checked", () => {
  for (const args of [
    [],
    ["next", "--source", "s1"],
    ["next", "--wait"],
    ["source", "show", "--source", "s1"],
    ["source", "reset", "--source", "s1", "--person-instructed"],
    ["source", "take-over", "--source", "s1", "--person-instructed"],
    ["cleanup", "--source", "s1", "--assignment", "a", "--person-instructed"],
    ["internal-review", "skip", "--source", "s1", "--person-instructed"],
    ["report", "submit", "--file", "r.json"],
    ["question", "ask", "--file", "q.json"],
    ["message", "read", "--key", "k"],
    ["message", "ack", "--key", "k"],
    ["dispatch", "--source"],
    ["toString", "--source", "s1"],
  ])
    expect(coordinatedSource(args)).toBeNull();
});
