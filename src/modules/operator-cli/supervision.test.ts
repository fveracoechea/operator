import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ErrAsync } from "unthrown";
import { coordinatedSource, refuseUnsupervised } from "./supervision.ts";
import { WorkSources } from "../work-sources/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Environment } from "../environment/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { workflowOutputSchema } from "../../lib/cli-result-fixture.ts";

afterEach(() => {
  mock.restore();
  process.exitCode = 0;
});

test("a different supervisor's refusal preserves authority and checked identities before continuation", async () => {
  const paths = OperatorHome.resolve(Environment.parse({ HOME: "/isolated", NODE_ENV: "test" }));
  const next = {
    decider: "super-agent" as const,
    question:
      "Will the recorded supervisor continue, or should the person authorize a source take-over?",
  };
  const state = { supervisorSession: "recorded", callerSession: "caller" };
  const checked = spyOn(WorkSources, "checkSupervisor").mockReturnValue(
    ErrAsync({
      reason: "source_supervised_elsewhere",
      detail: "Another session owns this source. Nothing changed.",
      next,
      state,
    }),
  );
  const tools = spyOn(ToolInvocation, "run");
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  expect(
    await refuseUnsupervised(["dispatch", "--source", "s1", "--assignment", "build"], paths, true),
  ).toBe(true);
  expect(checked).toHaveBeenCalledTimes(1);
  expect(checked).toHaveBeenCalledWith({ paths, cwd: process.cwd(), sourceId: "s1" });
  expect(workflowOutputSchema.parse(JSON.parse(String(log.mock.lastCall?.[0])))).toMatchObject({
    operation: "dispatch",
    outcome: "refused",
    reason: "source_supervised_elsewhere",
    next,
    state,
    blockers: [
      {
        reason: "source_supervised_elsewhere",
        detail: "Another session owns this source. Nothing changed.",
      },
    ],
  });
  expect(error.mock.calls.map(([line]) => String(line))).toEqual([
    "operator: source_supervised_elsewhere: Another session owns this source. Nothing changed.",
    "next: super-agent decides: Will the recorded supervisor continue, or should the person authorize a source take-over?",
    'state: supervisorSession="recorded" callerSession="caller"',
  ]);
  expect(process.exitCode).toBe(4);
  expect(tools).not.toHaveBeenCalled();
});

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
