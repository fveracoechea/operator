import { expect, test } from "bun:test";
import { WorkerKinds } from "./main.ts";

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
