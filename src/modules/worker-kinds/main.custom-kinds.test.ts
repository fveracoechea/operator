import { expect, test } from "bun:test";
import { WorkerKinds } from "./main.ts";

const audit = {
  completion: "report" as const,
  resources: "pane" as const,
  guide: "audit-guide/SKILL.md",
  workPhases: [{ name: "audit", goal: "Check evidence." }],
};

test("custom definitions receive defaults and resolve independent launch snapshots", () => {
  const definitions = WorkerKinds.customSchema().parse({ audit });
  const first = WorkerKinds.resolve("audit", definitions);
  expect(first).toEqual({
    ...audit,
    name: "audit",
    profile: null,
    nextKind: null,
    readsNote: false,
    skillsToRead: [],
    dispatchable: true,
  });
  const configuredPhase = definitions.audit?.workPhases[0];
  if (configuredPhase) configuredPhase.goal = "Changed later.";
  const snapshotPhase = first.workPhases[0];
  if (snapshotPhase) snapshotPhase.name = "local-change";
  expect(WorkerKinds.resolve("audit", definitions).workPhases).toEqual([
    { name: "audit", goal: "Changed later." },
  ]);
  expect(first.workPhases[0]?.goal).toBe("Check evidence.");
  expect(WorkerKinds.dispatchable("audit")).toBe(true);
  expect(WorkerKinds.dispatchable("review")).toBe(false);
  expect(() => WorkerKinds.resolve("missing", definitions)).toThrow();
});

test.each([
  { research: audit },
  { "Bad-name": audit },
  JSON.parse('{"__proto__":{}}'),
  { audit: { ...audit, guide: "../audit-guide/SKILL.md" } },
  { audit: { ...audit, workPhases: [] } },
  { audit: { ...audit, workPhases: [{ name: " ", goal: "Check." }] } },
  { audit: { ...audit, dispatchable: false } },
  { audit: { ...audit, extra: true } },
  { audit: { ...audit, nextKind: "missing" } },
  { audit: { ...audit, nextKind: "implementation" } },
])("rejects invalid custom policy %#", (definitions) => {
  expect(WorkerKinds.customSchema().safeParse(definitions).success).toBe(false);
});

test("next kinds must exist with matching completion, including built-in and custom successors", () => {
  expect(
    WorkerKinds.customSchema().parse({ audit: { ...audit, nextKind: "research" } }).audit?.nextKind,
  ).toBe("research");
  expect(
    WorkerKinds.customSchema().parse({ audit: { ...audit, nextKind: "publish" }, publish: audit })
      .audit?.nextKind,
  ).toBe("publish");
  expect(
    WorkerKinds.customSchema().safeParse({
      audit: { ...audit, nextKind: "publish" },
      publish: { ...audit, completion: "pr" },
    }).success,
  ).toBe(false);
});
