import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { deliveryFixture } from "./delivery-fixture.ts";
import { deliveryIdle, stackIdle } from "./delivery-guards.ts";
import { insertRow } from "./state-fixture.ts";

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
});
