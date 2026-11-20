import { expect, test } from "bun:test";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { briefPhase } from "./brief-phase.ts";

test("a decoded pending own report renders acceptance even when its assignment still runs", () => {
  expect(
    briefPhase({
      kind: WorkerKinds.resolve("research"),
      report: { decision: null },
      pullRequest: null,
      review: null,
      internalReview: false,
    }),
  ).toBe("acceptance");
});

test.each([
  { decision: "returned" as const, phase: "report" },
  { decision: "accepted" as const, phase: "complete" },
])(
  "a decoded $decision own report renders $phase without granting a transition",
  ({ decision, phase }) => {
    expect(
      briefPhase({
        kind: WorkerKinds.resolve("research"),
        report: { decision },
        pullRequest: null,
        review: null,
        internalReview: false,
      }),
    ).toBe(phase);
  },
);

test("a decoded mergedAt fact renders complete even before merge proof finishes the assignment", () => {
  expect(
    briefPhase({
      kind: WorkerKinds.resolve("implementation"),
      report: null,
      pullRequest: { mergedAt: "2026-11-17T00:00:00Z" },
      review: null,
      internalReview: false,
    }),
  ).toBe("complete");
});

test("unrecorded kinds have no phase, and absent reports preserve the kind's work phase", () => {
  const facts = { report: null, pullRequest: null, review: null, internalReview: false };
  expect(briefPhase({ ...facts, kind: null })).toBeUndefined();
  expect(briefPhase({ ...facts, kind: WorkerKinds.resolve("research") })).toBe("investigate");
  expect(briefPhase({ ...facts, kind: WorkerKinds.resolve("implementation") })).toBe("build");
  expect(
    briefPhase({
      ...facts,
      kind: {
        name: "person-defined",
        completion: "report",
        workPhases: [{ name: "inspect", guard: "worktree_clean" }],
      },
    }),
  ).toBe("inspect");
});

test.each([
  { internalReview: false, rounds: 0, phase: "feedback" },
  { internalReview: true, rounds: 0, phase: "review" },
  { internalReview: true, rounds: 1, phase: "ready" },
  { internalReview: true, rounds: 2, phase: "ready" },
])(
  "an associated PR with $rounds rounds and internal review $internalReview renders $phase",
  ({ internalReview, rounds, phase }) => {
    expect(
      briefPhase({
        kind: WorkerKinds.resolve("implementation"),
        report: null,
        pullRequest: { mergedAt: null },
        review: { state: "reviewing", rounds },
        internalReview,
      }),
    ).toBe(phase);
  },
);

test.each(["ready", "skipped"] as const)(
  "a recorded %s review renders feedback, not another review round",
  (state) => {
    expect(
      briefPhase({
        kind: WorkerKinds.resolve("implementation"),
        report: null,
        pullRequest: { mergedAt: null },
        review: { state, rounds: 1 },
        internalReview: true,
      }),
    ).toBe("feedback");
  },
);

test("an associated PR without a review record starts internal review from zero rounds", () => {
  expect(
    briefPhase({
      kind: WorkerKinds.resolve("implementation"),
      report: null,
      pullRequest: { mergedAt: null },
      review: null,
      internalReview: true,
    }),
  ).toBe("review");
});

test("a promoted launch's inherited report kind still observes its own report facts, not PR facts", () => {
  expect(
    briefPhase({
      kind: WorkerKinds.resolve("prototype"),
      report: null,
      pullRequest: { mergedAt: "2026-11-17T00:00:00Z" },
      review: { state: "ready", rounds: 2 },
      internalReview: true,
    }),
  ).toBe("react");
});
