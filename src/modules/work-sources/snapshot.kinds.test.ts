import { expect, test } from "bun:test";
import { z } from "zod";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { decodeSource } from "./snapshot.ts";
import { storedLaunch, storedSource } from "./source-fixture.ts";

test("a stored launch decodes its complete resolved kind independently of the plan", () => {
  const kind = {
    name: "answer",
    completion: "report",
    resources: "pane",
    profile: "careful",
    nextKind: null,
    readsNote: false,
    guide: "/owned/worker-agent/kinds/answer.md",
    skillsToRead: [],
    dispatchable: true,
    workPhases: [{ name: "investigate", goal: "Answer the assigned question." }],
  } satisfies ReturnType<typeof WorkerKinds.resolve>;
  const stored = storedSource([{ key: "read", completion: "report", state: "running" }], {
    launches: [storedLaunch("read", { kind: JSON.stringify(kind), profile: "careful" })],
  });
  const decoded = decodeSource({
    ...stored,
    source: {
      ...stored.source,
      plan: JSON.stringify({
        trackerKey: stored.source.trackerKey,
        assignments: [
          {
            key: "read",
            trackerKey: "APP-read",
            instructions: "Answer.",
            kind: "answer",
            completion: "report",
            resources: "pane",
            profile: "changed",
            dependencies: [],
          },
        ],
      }),
    },
    assignments: stored.assignments.map((assignment) => ({ ...assignment, kind: "answer" })),
  });
  expect(decoded.launches[0]?.kind).toEqual(kind);
  expect(decoded.planned[0]?.kind).toBe("answer");
  expect(decoded.planned[0]?.profile).toBe("changed");
  expect(decoded.launches[0]?.profile).toBe("careful");
});

test("an older launch's null kind remains null rather than a missing snapshot", () => {
  const decoded = decodeSource(
    storedSource([{ key: "read", completion: "report", state: "running" }], {
      launches: [storedLaunch("read", { kind: null })],
    }),
  );
  expect(decoded.launches[0]?.kind).toBeNull();
  expect(decoded.planned[0]?.kind).toBeNull();
});

test("stored kinds follow plan keys and order rather than stored row order", () => {
  const stored = storedSource([
    { key: "first", completion: "report", state: "ready" },
    { key: "second", completion: "report", state: "ready" },
  ]);
  const decoded = decodeSource({
    ...stored,
    assignments: stored.assignments
      .map((row) => ({ ...row, kind: row.key === "first" ? "research" : null }))
      .toReversed(),
  });
  expect(decoded.planned.map(({ key, kind }) => ({ key, kind }))).toEqual([
    { key: "first", kind: "research" },
    { key: "second", kind: null },
  ]);
  expect(decoded.assignments.map(({ key }) => key)).toEqual(["first", "second"]);
});

test("missing or duplicate stored assignment keys cannot supply another assignment's kind", () => {
  const stored = storedSource([
    { key: "first", completion: "report", state: "ready" },
    { key: "second", completion: "report", state: "ready" },
  ]);
  expect(() => decodeSource({ ...stored, assignments: stored.assignments.slice(1) })).toThrow(
    "Source rows do not match the supplied plan.",
  );
  expect(() =>
    decodeSource({
      ...stored,
      assignments: stored.assignments.map((row) => ({ ...row, key: "first" })),
    }),
  ).toThrow("Source rows do not match the supplied plan.");
});

test("a missing stored kind is corruption rather than the legacy null kind", () => {
  const stored = storedSource([{ key: "read", completion: "report", state: "ready" }]);
  for (const row of stored.assignments) Reflect.deleteProperty(row, "kind");
  expect(() => decodeSource(stored)).toThrow(z.ZodError);
});
