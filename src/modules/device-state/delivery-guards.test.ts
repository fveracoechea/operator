import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { deliveryFixture } from "./delivery-fixture.ts";
import { deliveryIdle, stackIdle } from "./delivery-guards.ts";
import { insertRow } from "./state-fixture.ts";

test("commit effects hold only their own assignment and stay held until reconciliation", () => {
  using client = deliveryFixture();
  const db = drizzle(client);
  insertRow(client, "commit_deliveries", {
    source_id: "s",
    assignment: "commit",
    revision: 1,
    data: JSON.stringify({ stage: "checkout" }),
  });
  expect(deliveryIdle(db, "s")).toMatchObject({ error: { reason: "commit_delivery_running" } });
  expect(deliveryIdle(db, "s", "commit")).toMatchObject({
    error: { reason: "commit_delivery_running" },
  });
  expect(deliveryIdle(db, "s", "unrelated").tag).toBe("Ok");
  expect(deliveryIdle(db, "other").tag).toBe("Ok");
  for (const stage of ["build", "review", "complete"]) {
    client.query("UPDATE commit_deliveries SET data = ?").run(JSON.stringify({ stage }));
    expect(deliveryIdle(db, "s").tag, stage).toBe("Ok");
  }
  for (const stage of ["local", "remote", "finalize"]) {
    client.query("UPDATE commit_deliveries SET data = ?").run(JSON.stringify({ stage }));
    expect(deliveryIdle(db, "s")).toMatchObject({ error: { reason: "commit_delivery_running" } });
  }
});

test("durable queue attempts hold source effects until merged or confirmed closed, but allow queue parking", () => {
  using client = deliveryFixture();
  const db = drizzle(client);
  expect(deliveryIdle(db, "s").tag).toBe("Ok");
  client.exec(`UPDATE pull_requests SET parking = '{"state":"parked","queueHead":"h"}'`);
  expect(deliveryIdle(db, "s")).toMatchObject({ error: { reason: "pr_delivery_running" } });
  expect(deliveryIdle(db, "s", "a", true).tag).toBe("Ok");
  expect(deliveryIdle(db, "s", "unrelated").tag).toBe("Ok");
  client.exec(`UPDATE pull_requests SET parking = '{"state":"closed","queueHead":"h"}'`);
  expect(deliveryIdle(db, "s").tag).toBe("Ok");
  client.exec(
    `UPDATE pull_requests SET parking = '{"state":"parked","queueHead":"h"}', merged_at = 'verified'`,
  );
  expect(deliveryIdle(db, "s").tag).toBe("Ok");
});

test("stack exclusion retains unreconciled effects even without a live claim", () => {
  using client = deliveryFixture();
  const db = drizzle(client);
  insertRow(client, "stack_operations", {
    id: "op",
    source_id: "s",
    assignment: "a",
    launch_id: "l",
    revision: 1,
    state: "failed",
    data: "{}",
  });
  expect(stackIdle(db, "s", "a")).toMatchObject({ error: { reason: "pr_stack_running" } });
  expect(stackIdle(db, "s", "other").tag).toBe("Ok");
  for (const state of ["complete", "cancelled"]) {
    client.query("UPDATE stack_operations SET state = ?").run(state);
    expect(stackIdle(db, "s", "a").tag).toBe("Ok");
  }
  client
    .query("UPDATE stack_operations SET owner_pid = ?, lease_at = ?")
    .run(process.pid, new Date().toISOString());
  expect(stackIdle(db, "s", "a")).toMatchObject({ error: { reason: "pr_stack_running" } });
});

test("unfinished direct intents fence their source and assignment even during queued parking", () => {
  using client = deliveryFixture();
  const db = drizzle(client);
  insertRow(client, "deliveries", {
    id: "direct",
    source_id: "s",
    assignment: "a",
    launch_id: "l",
    head: "h",
    readiness: "{}",
    selected: 0,
    started_at: "then",
  });
  for (const parking of [false, true]) {
    expect(deliveryIdle(db, "s", undefined, parking)).toMatchObject({
      error: { reason: "pr_delivery_running" },
    });
    expect(deliveryIdle(db, "s", "a", parking)).toMatchObject({
      error: { reason: "pr_delivery_running" },
    });
    expect(deliveryIdle(db, "s", "other", parking).tag).toBe("Ok");
    expect(deliveryIdle(db, "other", "a", parking).tag).toBe("Ok");
  }
  client.exec("UPDATE deliveries SET ended_at = 'verified'");
  expect(deliveryIdle(db, "s").tag).toBe("Ok");
});
