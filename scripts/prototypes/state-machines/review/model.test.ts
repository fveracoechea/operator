import { expect, test } from "bun:test";
import { finish, inspect, stateSchema } from "./model.ts";
import { decide } from "./table.ts";
import { facts, reviewing } from "./cases.fixture.ts";

test("closed review states reject stale as a lifecycle", () => {
  expect(stateSchema.safeParse({ ...reviewing, phase: "stale" }).success).toBe(false);
});

test("completion requires a post result, not host inactivity", () => {
  expect(finish(reviewing)).toMatchObject({
    status: "refused",
    reason: "no-operation",
    effects: [],
  });
  expect(inspect(decide, reviewing, { ...facts, worker: "stopped" }).needsAttention).toBe(true);
});
