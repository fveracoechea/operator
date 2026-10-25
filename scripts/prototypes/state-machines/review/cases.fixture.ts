import { expect, test } from "bun:test";
import { inspect, type Decide, type Event, type Facts, type State } from "./model.ts";

export const facts: Facts = {
  head: "abc",
  relation: "same",
  draftValid: true,
  failingCI: false,
  origin: "slack",
  ownPr: false,
  activity: "none",
  observation: "unknown",
  worker: "running",
};
export const reviewing: State = {
  phase: "reviewing",
  round: 1,
  headMoves: 0,
  scope: "full",
  operation: { status: "idle" },
};
export const draft: Event = { type: "draft", head: "abc", blockers: 0, strongBreach: false };

export function cases(decide: Decide) {
  test.each([
    { patch: {}, blockers: 0, strongBreach: false, event: "APPROVE" },
    { patch: {}, blockers: 1, strongBreach: false, event: "COMMENT" },
    { patch: { failingCI: true }, blockers: 0, strongBreach: false, event: "COMMENT" },
    { patch: {}, blockers: 1, strongBreach: true, event: "REQUEST_CHANGES" },
    { patch: { ownPr: true }, blockers: 0, strongBreach: false, event: "COMMENT" },
    { patch: { origin: "assignment" }, blockers: 0, strongBreach: false, event: "COMMENT" },
    {
      patch: { origin: "assignment", ownPr: true, failingCI: true },
      blockers: 1,
      strongBreach: true,
      event: "COMMENT",
    },
  ] satisfies { patch: Partial<Facts>; blockers: number; strongBreach: boolean; event: string }[])(
    "computed event %j",
    ({ patch, blockers, strongBreach, event }) => {
      const result = decide({
        state: reviewing,
        event: { type: "draft", head: "abc", blockers, strongBreach },
        facts: { ...facts, ...patch },
      });
      expect(result.effects[0]).toMatchObject({ event, head: "abc", headLimitWarning: false });
      expect(result.state.phase).toBe("posting");
    },
  );

  test("invalid draft refuses before head and event processing", () => {
    const result = decide({
      state: reviewing,
      event: draft,
      facts: { ...facts, draftValid: false, head: "new", failingCI: true },
    });
    expect(result).toEqual({
      status: "refused",
      reason: "invalid-draft",
      state: reviewing,
      effects: [],
    });
    expect(inspect(decide, reviewing, { ...facts, draftValid: false }).nextActions).not.toContain(
      "draft",
    );
  });

  test("retry rechecks CI, head and draft validity using the retained draft", () => {
    const requested = decide({ state: reviewing, event: draft, facts });
    const failed = decide({
      state: requested.state,
      event: { type: "result", key: requested.effects[0]!.key, outcome: "not-applied" },
      facts,
    });
    const ci = decide({
      state: failed.state,
      event: { type: "retry" },
      facts: { ...facts, failingCI: true },
    });
    expect(ci.effects[0]?.event).toBe("COMMENT");
    const moved = decide({
      state: failed.state,
      event: { type: "retry" },
      facts: { ...facts, head: "new", relation: "fast-forward" },
    });
    expect(moved).toMatchObject({
      reason: "review-new-commits",
      state: { phase: "reviewing", operation: { status: "idle" } },
      effects: [],
    });
    const newPost = decide({
      state: moved.state,
      event: { type: "draft", head: "new", blockers: 0, strongBreach: false },
      facts: { ...facts, head: "new" },
    });
    expect(newPost.effects[0]?.key).not.toBe(requested.effects[0]?.key);
    expect(
      decide({
        state: newPost.state,
        event: { type: "result", key: requested.effects[0]!.key, outcome: "done" },
        facts,
      }),
    ).toMatchObject({ status: "refused", reason: "stale-result", effects: [] });
    const invalid = decide({
      state: failed.state,
      event: { type: "retry" },
      facts: { ...facts, draftValid: false },
    });
    expect(invalid).toEqual({
      status: "refused",
      reason: "invalid-draft",
      state: failed.state,
      effects: [],
    });
    const limited = decide({
      state: { ...failed.state, headMoves: 3 },
      event: { type: "retry" },
      facts: { ...facts, head: "new" },
    });
    expect(limited.effects[0]?.headLimitWarning).toBe(true);
  });

  test.each(["fast-forward", "force-push"] satisfies Facts["relation"][])(
    "head move %s requests review before posting, then bounds churn",
    (relation) => {
      let state = reviewing;
      for (let i = 1; i <= 3; i++) {
        const result = decide({
          state,
          event: draft,
          facts: { ...facts, head: `head-${i}`, relation },
        });
        expect(result.effects).toEqual([]);
        expect(result.reason).toBe(
          relation === "force-push" ? "review-from-start" : "review-new-commits",
        );
        expect(result.state).toMatchObject({
          headMoves: i,
          scope: relation === "force-push" ? "full" : "incremental",
        });
        state = result.state;
      }
      const limited = decide({
        state,
        event: draft,
        facts: { ...facts, head: "head-4", relation },
      });
      expect(limited.effects[0]).toMatchObject({ head: "abc", headLimitWarning: true });
    },
  );

  test("duplicate posts, stale results, failed action, retry and unknown outcome", () => {
    const requested = decide({ state: reviewing, event: draft, facts });
    expect(decide({ state: requested.state, event: draft, facts })).toMatchObject({
      status: "refused",
      reason: "operation-pending",
      effects: [],
    });
    const key = requested.effects[0]!.key;
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
      event: { type: "result", key, outcome: "not-applied" },
      facts,
    });
    expect(failed.state).toMatchObject({ phase: "posting", operation: { status: "failed" } });
    const retry = decide({ state: failed.state, event: { type: "retry" }, facts });
    expect(retry.effects[0]).toMatchObject({ attempt: 2, event: "APPROVE", head: "abc" });
    expect(retry.effects[0]?.key).not.toBe(key);
    expect(
      decide({ state: retry.state, event: { type: "result", key, outcome: "done" }, facts }).reason,
    ).toBe("stale-result");
    const unknown = decide({
      state: requested.state,
      event: { type: "result", key, outcome: "unknown" },
      facts,
    });
    expect(
      decide({ state: unknown.state, event: { type: "result", key, outcome: "done" }, facts }),
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
    expect(recovered.state.phase).toBe("approved");
    expect(recovered.effects).toEqual([]);
    const notApplied = decide({
      state: requested.state,
      event: { type: "recover" },
      facts: { ...facts, observation: "not-done" },
    });
    expect(notApplied.state.operation.status).toBe("failed");
    expect(notApplied.effects).toEqual([]);
  });

  test.each(["commits", "reply", "resolved-thread", "renewed"] satisfies Facts["activity"][])(
    "new %s starts a round but approval stops ordinary watching",
    (activity) => {
      const watching: State = { ...reviewing, phase: "watching" };
      const result = decide({
        state: watching,
        event: { type: "activity" },
        facts: { ...facts, activity },
      });
      expect(result.state).toMatchObject({ phase: "reviewing", round: 2 });
      const approved = decide({
        state: { ...watching, phase: "approved" },
        event: { type: "activity" },
        facts: { ...facts, activity },
      });
      expect(approved.status).toBe(activity === "renewed" ? "changed" : "refused");
      expect(approved.effects).toEqual([]);
    },
  );

  test("no activity is not a new round, stopped reviewer needs attention", () => {
    expect(
      decide({ state: { ...reviewing, phase: "watching" }, event: { type: "activity" }, facts })
        .reason,
    ).toBe("no-new-activity");
    expect(inspect(decide, reviewing, { ...facts, worker: "stopped" }).needsAttention).toBe(true);
    expect(reviewing.phase).toBe("reviewing");
  });

  test("start, comment outcome and terminal states refuse repeated events", () => {
    const queued: State = { ...reviewing, phase: "queued", round: 0 };
    const started = decide({ state: queued, event: { type: "start" }, facts });
    expect(started.state).toMatchObject({ phase: "reviewing", round: 1 });
    expect(decide({ state: started.state, event: { type: "start" }, facts }).status).toBe(
      "refused",
    );
    const requested = decide({
      state: started.state,
      event: { type: "draft", head: "abc", blockers: 1, strongBreach: false },
      facts,
    });
    const posted = decide({
      state: requested.state,
      event: { type: "result", key: requested.effects[0]!.key, outcome: "done" },
      facts,
    });
    expect(posted.state.phase).toBe("watching");
    expect(decide({ state: posted.state, event: draft, facts }).status).toBe("refused");
    for (const type of ["close", "skip"] satisfies Event["type"][]) {
      const ended = decide({ state: posted.state, event: { type }, facts });
      expect(ended.state.phase).toBe(type === "close" ? "closed" : "skipped");
      expect(decide({ state: ended.state, event: { type }, facts }).status).toBe("refused");
      expect(decide({ state: ended.state, event: { type: "start" }, facts }).effects).toEqual([]);
    }
  });

  test("decisions are deterministic and preserve their inputs", () => {
    const input = { state: structuredClone(reviewing), event: draft, facts: { ...facts } };
    const before = structuredClone(input);
    expect(decide(input)).toEqual(decide(input));
    expect(input).toEqual(before);
  });
}
