import { expect, test } from "bun:test";
import { decodeSource } from "./snapshot.ts";
import { storedLaunch, storedSource } from "./source-fixture.ts";

test("stored assignment kinds are independent of the original plan and preserve null legacy kinds", () => {
  const input = storedSource([
    { key: "read", completion: "report", state: "ready" },
    { key: "legacy", completion: "report", state: "ready" },
  ]);
  input.assignments = input.assignments.map((row) => ({
    ...row,
    kind: row.key === "read" ? "audit" : null,
  }));
  const decoded = decodeSource(input);
  expect(decoded.planned.map(({ key, kind }) => ({ key, kind }))).toEqual([
    { key: "read", kind: "audit" },
    { key: "legacy", kind: null },
  ]);
  expect(decoded.plan.assignments[0]?.kind).toBeNull();
});

test("launch snapshots decode historical custom policy without consulting current settings", () => {
  const kind = {
    name: "audit",
    completion: "report" as const,
    resources: "pane" as const,
    profile: "old-profile",
    nextKind: null,
    readsNote: false,
    guide: "/installed/old-guide/SKILL.md",
    skillsToRead: [],
    dispatchable: true,
    workPhases: [{ name: "audit", goal: "Original goal." }],
  };
  const input = storedSource([{ key: "read", completion: "report", state: "running" }], {
    launches: [storedLaunch("read", { kind: JSON.stringify(kind) })],
  });
  input.assignments = input.assignments.map((row) => ({ ...row, kind: "audit" }));
  const decoded = decodeSource(input);
  expect(decoded.launches[0]?.kind).toEqual(kind);
  const phase = kind.workPhases[0];
  if (phase) phase.goal = "New settings goal.";
  expect(decoded.launches[0]?.kind?.workPhases).toEqual([
    { name: "audit", goal: "Original goal." },
  ]);
  expect(() =>
    decodeSource({
      ...input,
      launches: [
        storedLaunch("read", { kind: JSON.stringify({ ...kind, completion: "unknown" }) }),
      ],
    }),
  ).toThrow();
});
