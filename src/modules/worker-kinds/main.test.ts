import { expect, test } from "bun:test";
import { WorkerKinds } from "./main.ts";

test("imperative PR owners share the phase ownership, round, and cleanliness policy", () => {
  expect(WorkerKinds.refusesPrGuard({ guard: "ownership", handedOff: true })).toBe(true);
  expect(WorkerKinds.refusesPrGuard({ guard: "ownership", handedOff: false })).toBe(false);
  expect(WorkerKinds.refusesPrGuard({ guard: "round", rounds: 1 })).toBe(false);
  expect(WorkerKinds.refusesPrGuard({ guard: "round", rounds: 2 })).toBe(true);
  expect(WorkerKinds.refusesPrGuard({ guard: "worktree_clean", changed: true })).toBe(true);
  expect(WorkerKinds.refusesPrGuard({ guard: "worktree_clean", changed: false })).toBe(false);
});

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

test("the six built-in kinds fix completion and their launch policy", () => {
  expect(WorkerKinds.names()).toEqual([
    "research",
    "answer",
    "prototype",
    "implementation",
    "review",
    "pr-feedback",
  ]);
  const policies = [
    {
      name: "research",
      completion: "report",
      resources: "pane",
      nextKind: null,
      readsNote: false,
      dispatchable: true,
      phases: ["investigate"],
    },
    {
      name: "answer",
      completion: "report",
      resources: "pane",
      nextKind: null,
      readsNote: false,
      dispatchable: true,
      phases: ["investigate"],
    },
    {
      name: "prototype",
      completion: "report",
      resources: "worktree",
      nextKind: null,
      readsNote: false,
      dispatchable: true,
      phases: ["build", "react"],
    },
    {
      name: "implementation",
      completion: "pr",
      resources: "worktree",
      nextKind: "review",
      readsNote: "promotion",
      dispatchable: true,
      phases: ["build"],
    },
    {
      name: "review",
      completion: "pr",
      resources: "worktree",
      nextKind: "pr-feedback",
      readsNote: false,
      dispatchable: false,
      phases: [],
    },
    {
      name: "pr-feedback",
      completion: "pr",
      resources: "worktree",
      nextKind: null,
      readsNote: true,
      dispatchable: false,
      phases: [],
    },
  ] as const;
  for (const { phases, ...policy } of policies) {
    const kind = WorkerKinds.resolve(policy.name);
    expect(kind).toMatchObject({
      ...policy,
      profile: null,
      guide: `worker-agent/kinds/${policy.name}.md`,
    });
    expect(kind.workPhases.map((phase) => phase.name)).toEqual([...phases]);
    for (const phase of kind.workPhases) expect(phase.goal).toMatch(/\S/);
    expect(WorkerKinds.snapshotSchema().parse(kind)).toEqual(kind);
  }
});

test("a resolved kind is independent of another launch's copy", () => {
  const changed = WorkerKinds.resolve("research");
  changed.workPhases.length = 0;
  expect(WorkerKinds.resolve("research").workPhases).toMatchObject([{ name: "investigate" }]);
});

test("only answer launches name an optional visual skill fallback", () => {
  expect(WorkerKinds.resolve("answer").skillsToRead).toEqual(["show-me"]);
  for (const name of ["research", "prototype", "implementation", "review", "pr-feedback"] as const)
    expect(WorkerKinds.resolve(name).skillsToRead).toEqual([]);
});

test("snapshots preserve fallback paths and accept earlier snapshots without them", () => {
  const snapshot = {
    name: "answer" as const,
    completion: "report" as const,
    resources: "pane" as const,
    profile: null,
    nextKind: null,
    readsNote: false,
    guide: "/owned/worker-agent/kinds/answer.md",
    dispatchable: true,
    workPhases: [{ name: "investigate", goal: "Answer the assigned question." }],
  };
  expect(WorkerKinds.snapshotSchema().parse(snapshot)).toEqual({ ...snapshot, skillsToRead: [] });
  const current = { ...snapshot, skillsToRead: ["/upstream/show-me/SKILL.md"] };
  expect(WorkerKinds.snapshotSchema().parse(current)).toEqual(current);
});
