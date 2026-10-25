import { expect, test } from "bun:test";
import { inspect, type Decide, type Effect, type Event, type Facts, type State } from "./model.ts";

export const facts: Facts = {
  dependenciesReady: true,
  actor: "superagent",
  worker: "running",
  approved: true,
  checks: "pass",
  threadsResolved: true,
  defaultBase: true,
  safeToRemove: true,
  observation: "unknown",
};
export const pr = {
  completion: "pr",
  phase: "pr-open",
  generation: 0,
  operation: { status: "idle" },
} satisfies State;
export const report = {
  completion: "report",
  phase: "running",
  reports: [],
  followUp: null,
  generation: 0,
  operation: { status: "idle" },
} satisfies State;

export function cases(decide: Decide) {
  test.each([
    { patch: { approved: false }, reason: "approval-required" },
    { patch: { checks: "fail" }, reason: "checks-not-passing" },
    { patch: { checks: "pending" }, reason: "checks-not-passing" },
    { patch: { threadsResolved: false }, reason: "unresolved-threads" },
    { patch: { defaultBase: false }, reason: "default-base-required" },
    {
      patch: { approved: false, checks: "fail", threadsResolved: false, defaultBase: false },
      reason: "approval-required",
    },
  ] satisfies { patch: Partial<Facts>; reason: string }[])(
    "merge guard %j",
    ({ patch, reason }) => {
      const result = decide({ state: pr, event: { type: "merge" }, facts: { ...facts, ...patch } });
      expect(result).toEqual({ status: "refused", reason, state: pr, effects: [] });
      const view = inspect(decide, pr, { ...facts, ...patch });
      expect(view.nextActions).not.toContain("merge");
      expect(view.blockers).toContain(reason);
      const requested = decide({ state: pr, event: { type: "merge" }, facts });
      const failed = decide({
        state: requested.state,
        event: { type: "result", key: requested.effects[0]!.key, outcome: "not-applied" },
        facts,
      });
      expect(
        decide({ state: failed.state, event: { type: "retry" }, facts: { ...facts, ...patch } }),
      ).toEqual({ status: "refused", reason, state: failed.state, effects: [] });
    },
  );

  test("dependencies and state prevent a second start", () => {
    const ready: State = { ...pr, phase: "ready" };
    expect(
      decide({
        state: ready,
        event: { type: "start" },
        facts: { ...facts, dependenciesReady: false },
      }).reason,
    ).toBe("dependencies-not-ready");
    const start = decide({ state: ready, event: { type: "start" }, facts });
    expect(start.state.phase).toBe("running");
    expect(decide({ state: start.state, event: { type: "start" }, facts }).status).toBe("refused");
    const open = decide({ state: start.state, event: { type: "open-pr" }, facts });
    expect(inspect(decide, open.state, facts).dependencyReady).toBe(true);
  });

  test.each([{ type: "merge" }, { type: "open-pr" }] satisfies Event[])(
    "report refuses PR event %j",
    (event) => {
      expect(decide({ state: report, event, facts })).toMatchObject({
        status: "refused",
        state: report,
        effects: [],
      });
    },
  );

  test("submission is not acceptance, follow-up preserves the report history", () => {
    const submitted = decide({
      state: report,
      event: { type: "submit", report: "/scratch/report-1.md" },
      facts,
    });
    expect(submitted.state.phase).toBe("reported");
    expect(submitted.effects).toEqual([]);
    expect(inspect(decide, submitted.state, facts).dependencyReady).toBe(false);
    expect(inspect(decide, submitted.state, facts).nextActions).toContain("accept");
    const worker = decide({
      state: submitted.state,
      event: { type: "accept" },
      facts: { ...facts, actor: "worker" },
    });
    expect(worker.reason).toBe("superagent-required");
    expect(worker.effects).toEqual([]);
    expect(
      decide({
        state: submitted.state,
        event: { type: "return", instructions: "check the evidence" },
        facts: { ...facts, actor: "worker" },
      }).reason,
    ).toBe("superagent-required");
    const returned = decide({
      state: submitted.state,
      event: { type: "return", instructions: "check the evidence" },
      facts,
    });
    expect(returned.state.phase).toBe("reported");
    expect(decide({ state: returned.state, event: { type: "accept" }, facts }).status).toBe(
      "refused",
    );
    expect(decide({ state: submitted.state, event: { type: "resume" }, facts }).reason).toBe(
      "follow-up-required",
    );
    const resumed = decide({ state: returned.state, event: { type: "resume" }, facts });
    expect(resumed.state).toMatchObject({
      phase: "running",
      reports: ["/scratch/report-1.md"],
      followUp: "check the evidence",
    });
    const second = decide({
      state: resumed.state,
      event: { type: "submit", report: "/scratch/report-2.md" },
      facts,
    });
    const accepted = decide({ state: second.state, event: { type: "accept" }, facts });
    expect(accepted.state).toMatchObject({
      phase: "completed",
      reports: ["/scratch/report-1.md", "/scratch/report-2.md"],
      followUp: null,
    });
    expect(accepted.effects.map((effect) => effect.type)).toEqual(["close-pane"]);
    expect(inspect(decide, accepted.state, facts).dependencyReady).toBe(true);
    const closed = decide({
      state: accepted.state,
      event: { type: "result", key: accepted.effects[0]!.key, outcome: "done" },
      facts,
    });
    expect(closed.state.operation.status).toBe("idle");
    expect(closed.effects).toEqual([]);
    expect(decide({ state: closed.state, event: { type: "accept" }, facts }).status).toBe(
      "refused",
    );
  });

  test("stopped workers need attention but do not complete either assignment", () => {
    for (const state of [pr, report]) {
      const view = inspect(decide, state, { ...facts, worker: "stopped" });
      expect(view.needsAttention).toBe(true);
      expect(state.phase).not.toBe("completed");
      expect(state.phase).not.toBe("merged");
    }
  });

  test("merge result requests cleanup in its declared order", () => {
    let result = decide({ state: pr, event: { type: "merge" }, facts });
    expect(result.state.phase).toBe("pr-open");
    for (const type of [
      "merge-pr",
      "delete-remote-branch",
      "close-pane",
      "remove-worktree",
    ] satisfies Effect["type"][]) {
      expect(result.effects.map((effect) => effect.type)).toEqual([type]);
      result = decide({
        state: result.state,
        event: { type: "result", key: result.effects[0]!.key, outcome: "done" },
        facts,
      });
    }
    expect(result.state.phase).toBe("merged");
    expect(result.state.operation.status).toBe("idle");
    expect(result.effects).toEqual([]);
    expect(decide({ state: result.state, event: { type: "merge" }, facts }).status).toBe("refused");
  });

  test("unlanded work leaves a visible cleanup obligation without deletion", () => {
    let result = decide({ state: pr, event: { type: "merge" }, facts });
    const unsafe = { ...facts, safeToRemove: false };
    for (let i = 0; i < 3; i++)
      result = decide({
        state: result.state,
        event: { type: "result", key: result.effects[0]!.key, outcome: "done" },
        facts: unsafe,
      });
    expect(result.state).toMatchObject({
      phase: "merged",
      operation: { status: "failed", effect: "remove-worktree" },
    });
    expect(result.effects).toEqual([]);
    expect(decide({ state: result.state, event: { type: "retry" }, facts: unsafe }).reason).toBe(
      "unlanded-work",
    );
    expect(inspect(decide, result.state, unsafe).blockers).toContain("unlanded-work");
  });

  for (const [label, initial, event] of [
    ["PR merge", pr, { type: "merge" }],
    ["report cleanup", { ...report, phase: "reported" }, { type: "accept" }],
  ] satisfies [string, State, Event][]) {
    test(`${label}: duplicate, stale result, failure, retry, interruption and recovery`, () => {
      const requested = decide({ state: initial, event, facts });
      const effect = requested.effects[0]!;
      expect(decide({ state: requested.state, event, facts })).toMatchObject({
        status: "refused",
        reason: "operation-pending",
        effects: [],
      });
      expect(
        decide({
          state: requested.state,
          event: { type: "result", key: "old", outcome: "done" },
          facts,
        }).reason,
      ).toBe("stale-result");
      expect(decide({ state: requested.state, event: { type: "retry" }, facts }).reason).toBe(
        "reconcile-before-retry",
      );
      const failed = decide({
        state: requested.state,
        event: { type: "result", key: effect.key, outcome: "not-applied" },
        facts,
      });
      expect(failed.state.phase).toBe(initial.phase === "reported" ? "completed" : initial.phase);
      const retried = decide({ state: failed.state, event: { type: "retry" }, facts });
      expect(retried.effects[0]?.attempt).toBe(2);
      expect(retried.effects[0]?.key).not.toBe(effect.key);
      expect(
        decide({
          state: retried.state,
          event: { type: "result", key: effect.key, outcome: "done" },
          facts,
        }).reason,
      ).toBe("stale-result");
      const unknown = decide({
        state: requested.state,
        event: { type: "result", key: effect.key, outcome: "unknown" },
        facts,
      });
      expect(
        decide({
          state: unknown.state,
          event: { type: "result", key: effect.key, outcome: "done" },
          facts,
        }),
      ).toMatchObject({ status: "refused", reason: "stale-result", effects: [] });
      expect(decide({ state: unknown.state, event: { type: "retry" }, facts }).reason).toBe(
        "reconcile-before-retry",
      );
      expect(decide({ state: unknown.state, event: { type: "recover" }, facts }).reason).toBe(
        "outcome-unknown",
      );
      const recovered = decide({
        state: structuredClone(requested.state),
        event: { type: "recover" },
        facts: { ...facts, observation: "done" },
      });
      expect(recovered.state.phase).toBe(initial.completion === "pr" ? "merged" : "completed");
      expect(recovered.effects.some((effect) => effect.type === "merge-pr")).toBe(false);
      const notApplied = decide({
        state: requested.state,
        event: { type: "recover" },
        facts: { ...facts, observation: "not-done" },
      });
      expect(notApplied.state.operation.status).toBe("failed");
      expect(notApplied.effects).toEqual([]);
    });
  }

  test("all decisions are deterministic and do not mutate supplied inputs", () => {
    const input = {
      state: structuredClone(pr),
      event: { type: "merge" },
      facts: { ...facts },
    } satisfies Parameters<Decide>[0];
    const before = structuredClone(input);
    expect(decide(input)).toEqual(decide(input));
    expect(input).toEqual(before);
  });
}
