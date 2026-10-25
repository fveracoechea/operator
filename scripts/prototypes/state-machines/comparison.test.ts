import { expect, expectTypeOf, test } from "bun:test";
import * as assignment from "./assignment/model.ts";
import { decide as assignmentReducer } from "./assignment/reducer.ts";
import { decide as assignmentTable } from "./assignment/table.ts";
import { facts as assignmentFacts, pr, report } from "./assignment/cases.fixture.ts";
import * as review from "./review/model.ts";
import { decide as reviewReducer } from "./review/reducer.ts";
import { decide as reviewTable } from "./review/table.ts";
import { facts as reviewFacts, reviewing, draft } from "./review/cases.fixture.ts";

test("assignment designs give identical decisions and next actions across the closed state/event matrix", () => {
  const states: assignment.State[] = [
    ...(
      ["ready", "running", "pr-open", "merged", "abandoned"] satisfies Extract<
        assignment.State,
        { completion: "pr" }
      >["phase"][]
    ).map((phase) => assignment.stateSchema.parse({ ...pr, phase })),
    ...["ready", "running", "reported", "completed", "abandoned"].map((phase) =>
      assignment.stateSchema.parse({ ...report, phase, reports: ["/scratch/report.md"] }),
    ),
    { ...pr, operation: { status: "pending", effect: "merge-pr", key: "pending", attempt: 1 } },
    {
      ...pr,
      operation: { status: "failed", effect: "remove-worktree", key: "pending", attempt: 1 },
    },
    { ...pr, operation: { status: "unknown", effect: "merge-pr", key: "pending", attempt: 1 } },
  ];
  const events: assignment.Event[] = [
    { type: "start" },
    { type: "open-pr" },
    { type: "submit", report: "/scratch/report.md" },
    { type: "accept" },
    { type: "return", instructions: "check evidence" },
    { type: "resume" },
    { type: "merge" },
    { type: "retry" },
    { type: "recover" },
    { type: "result", key: "pending", outcome: "done" },
    { type: "result", key: "pending", outcome: "not-applied" },
    { type: "result", key: "pending", outcome: "unknown" },
    { type: "result", key: "stale", outcome: "done" },
  ];
  const variations: Partial<assignment.Facts>[] = [
    {},
    { approved: false, checks: "fail", defaultBase: false },
    { actor: "worker" },
    { dependenciesReady: false },
    { worker: "stopped" },
    { observation: "done" },
    { observation: "not-done" },
    { safeToRemove: false },
  ];
  let count = 0;
  for (const state of states)
    for (const patch of variations) {
      const facts = { ...assignmentFacts, ...patch };
      for (const event of events) {
        const input = { state, event, facts };
        expect(assignmentTable(input)).toEqual(assignmentReducer(input));
        count++;
      }
      expect(assignment.inspect(assignmentTable, state, facts)).toEqual(
        assignment.inspect(assignmentReducer, state, facts),
      );
    }
  expect(count).toBe(1352);
});

test("review designs give identical decisions and next actions across the closed state/event matrix", () => {
  const states: review.State[] = [
    ...review.stateSchema.shape.phase.options.map((phase) => ({ ...reviewing, phase })),
    { ...reviewing, headMoves: 3 },
    ...(["pending", "failed", "unknown"] satisfies ("pending" | "failed" | "unknown")[]).map(
      (status) =>
        review.stateSchema.parse({
          ...reviewing,
          phase: "posting",
          operation: {
            status,
            effect: {
              type: "post-review",
              key: "pending",
              attempt: 1,
              head: "abc",
              event: "APPROVE",
              headLimitWarning: false,
              blockers: 0,
              strongBreach: false,
            },
          },
        }),
    ),
  ];
  const events: review.Event[] = [
    { type: "start" },
    draft,
    { type: "draft", head: "old", blockers: 1, strongBreach: true },
    { type: "activity" },
    { type: "close" },
    { type: "skip" },
    { type: "retry" },
    { type: "recover" },
    { type: "result", key: "pending", outcome: "done" },
    { type: "result", key: "pending", outcome: "not-applied" },
    { type: "result", key: "pending", outcome: "unknown" },
    { type: "result", key: "stale", outcome: "done" },
  ];
  const variations: Partial<review.Facts>[] = [
    {},
    { draftValid: false },
    { failingCI: true },
    { origin: "assignment" },
    { ownPr: true },
    { head: "new", relation: "fast-forward" },
    { head: "new", relation: "force-push" },
    { activity: "commits" },
    { activity: "renewed" },
    { observation: "done" },
    { observation: "not-done" },
    { worker: "stopped" },
  ];
  let count = 0;
  for (const state of states)
    for (const patch of variations) {
      const facts = { ...reviewFacts, ...patch };
      for (const event of events) {
        expect(reviewTable({ state, event, facts })).toEqual(
          reviewReducer({ state, event, facts }),
        );
        count++;
      }
      expect(review.inspect(reviewTable, state, facts)).toEqual(
        review.inspect(reviewReducer, state, facts),
      );
    }
  expect(count).toBe(1584);
});

test("types reject open events and the wrong completion state's name", () => {
  expectTypeOf<string>().not.toMatchTypeOf<assignment.Event["type"]>();
  expectTypeOf<string>().not.toMatchTypeOf<review.Event["type"]>();
  expectTypeOf<"merged">().not.toMatchTypeOf<
    Extract<assignment.State, { completion: "report" }>["phase"]
  >();
  expectTypeOf<"completed">().not.toMatchTypeOf<
    Extract<assignment.State, { completion: "pr" }>["phase"]
  >();
});
