import { expect, test } from "bun:test";
import { WorkerKinds } from "./main.ts";

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
