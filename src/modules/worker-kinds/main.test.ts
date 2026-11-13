import { expect, test } from "bun:test";
import { WorkerKinds } from "./main.ts";

test("kind snapshots preserve ordered free work and validate the closed exit guard catalog", () => {
  const prototype = WorkerKinds.resolve("prototype");
  expect(prototype.workPhases).toEqual([
    { name: "build", goal: "Build the assigned prototype." },
    { name: "react", goal: "Gather a reaction to the prototype." },
  ]);
  for (const guard of [
    "report_submitted",
    "pr_associated",
    "round_recorded",
    "pr_ready",
    "worktree_clean",
    "pr_merged",
  ] as const) {
    expect(
      WorkerKinds.snapshotSchema().parse({
        ...prototype,
        workPhases: [{ name: "verify", goal: "Verify.", guard }],
      }).workPhases,
    ).toEqual([{ name: "verify", goal: "Verify.", guard }]);
  }
  expect(
    WorkerKinds.snapshotSchema().safeParse({
      ...prototype,
      workPhases: [{ name: "verify", goal: "Verify.", guard: "reaction_received" }],
    }).success,
  ).toBe(false);
  expect(
    WorkerKinds.decidePhase({
      kind: prototype,
      report: null,
      pr: { associated: false, rounds: 0, ready: false, merged: false, parked: false },
      internalReview: false,
      worktreeClean: true,
    }),
  ).toMatchObject({
    kind: "prototype",
    phase: "react",
    next: { command: "operator report submit --file <file>" },
  });
  expect(
    WorkerKinds.decidePhase(
      {
        kind: WorkerKinds.resolve("review"),
        report: null,
        pr: { associated: true, rounds: 0, ready: false, merged: false, parked: false },
        internalReview: true,
        worktreeClean: true,
      },
      "ready",
    ),
  ).toMatchObject({ refusal: { reason: "internal_review_round_missing" } });
});
