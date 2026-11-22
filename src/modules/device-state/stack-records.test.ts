import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Ok } from "unthrown";
import { stackRecord } from "./stack-records.ts";
import { stackOperations } from "./schema.ts";
import { insertRow } from "./state-fixture.ts";
import { stackStateFixture, stackFixturePlan } from "./stack-fixture.ts";
import { changeStack, readStack, restartStackReview, finishStack } from "./stacks.ts";

const corruptions = [
  { number: 9 },
  { id: "another" },
  { sourceId: "other" },
  { assignment: "right" },
  { repository: "other/repo" },
  { launchId: "right" },
  { branch: "task/right" },
  { worktree: "/right" },
  { originalRef: "refs/heads/task/right" },
  { previousOwners: ["right"] },
  { parents: [{ assignment: "right", number: 8, branch: "task/right", head: "p", base: "main" }] },
  { parents: [{ assignment: "left", number: 8, branch: "task/left", head: "p", base: "main" }] },
];

test.each(corruptions)(
  "stored operation identity corruption %j never reaches a mutation callback",
  (change) => {
    using client = stackStateFixture();
    const plan = stackFixturePlan();
    insertRow(client, "stack_operations", {
      id: plan.id,
      source_id: "source",
      assignment: "left",
      launch_id: "left",
      revision: 1,
      state: "planned",
      data: JSON.stringify({ ...plan, ...change }),
      owner_pid: process.pid,
    });
    const before = client.serialize();
    let called = false;
    expect(readStack(client, "left", plan.id)).toMatchObject({
      tag: "Err",
      error: { reason: "state_corrupt" },
    });
    expect(
      changeStack(client, "left", plan.id, 1, () => {
        called = true;
        return Ok({ state: "planned", data: JSON.stringify(plan), ownerPid: null });
      }),
    ).toMatchObject({ tag: "Err", error: { reason: "state_corrupt" } });
    expect(restartStackReview(client, "left", plan.id, 1)).toMatchObject({
      tag: "Err",
      error: { reason: "state_corrupt" },
    });
    expect(
      finishStack(client, "left", plan.id, 1, { data: "{}", base: "{}", relay: "{}" }),
    ).toMatchObject({ tag: "Err", error: { reason: "state_corrupt" } });
    expect(called).toBe(false);
    expect(client.serialize()).toEqual(before);
  },
);

test("known historical optional fields remain absent rather than invented or rejected by identity decoding", () => {
  using client = stackStateFixture();
  const plan = stackFixturePlan();
  const { attempts, ...legacy } = plan;
  expect(attempts).toEqual([]);
  insertRow(client, "stack_operations", {
    id: plan.id,
    source_id: "source",
    assignment: "left",
    launch_id: "left",
    revision: 1,
    state: "planned",
    data: JSON.stringify(legacy),
  });
  const db = drizzle(client);
  const row = db.select().from(stackOperations).get();
  expect(row).toBeDefined();
  if (row === undefined) return;
  const decoded = stackRecord(db, row);
  expect(decoded).toMatchObject({ tag: "Ok", value: { attempts: [] } });
  if (decoded.tag !== "Ok") return;
  expect(decoded.value.remoteUrl).toBeUndefined();
  expect(decoded.value.worktree).toBeUndefined();
  expect(decoded.value.originalRef).toBeUndefined();
  expect(client.query("SELECT data FROM stack_operations").get()).toEqual({
    data: JSON.stringify(legacy),
  });
});
