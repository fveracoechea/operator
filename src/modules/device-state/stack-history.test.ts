import { expect, test } from "bun:test";
import { stackHistory } from "./stack-history.ts";

test("migration-origin unknown readiness stays unknown in the typed archive", () => {
  const readiness = {
    origin: "migration-0026",
    head: null,
    at: "migration",
    note: null,
    dispositions: [],
  };
  const archived = {
    version: 1,
    operation: "stack",
    review: null,
    rounds: [],
    readinessRaw: JSON.stringify(readiness),
    readiness,
    progress: '{"seen":["comment"]}',
    parking: null,
    handoff: null,
  };
  expect(stackHistory(JSON.stringify(archived))).toEqual(archived);
  expect(
    stackHistory(JSON.stringify({ ...archived, readinessRaw: null, readiness: null })),
  ).toMatchObject({ readinessRaw: null, readiness: null });
  expect(() =>
    stackHistory(JSON.stringify({ ...archived, readiness: { ...readiness, head: "invented" } })),
  ).toThrow();
  expect(() => stackHistory(JSON.stringify({ ...archived, version: 2 }))).toThrow();
});

test("known legacy archives stay accessible without inventing readiness", () => {
  const prior = { review: null, rounds: [] };
  expect(stackHistory(JSON.stringify(prior))).toEqual(prior);
  expect(() => stackHistory('{"review":null,"rounds":[],"unknown":true}')).toThrow();
});
