import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { migrationsFolder } from "./database.ts";
import { recordKindHandoff } from "./kind-handoff-record.ts";

test("a ready transition preserves its exact receipt timestamp in the outgoing handoff", () => {
  using client = new Database(":memory:");
  const db = drizzle(client);
  migrate(db, { migrationsFolder });
  const at = "2026-11-18T01:02:03.004Z";
  expect(
    recordKindHandoff(
      db,
      { sourceId: "s", assignment: "a", launchId: "outgoing" },
      "pr-feedback",
      at,
    ),
  ).toMatchObject({ tag: "Ok" });
  expect(client.query("SELECT started_at, updated_at, lease_at FROM kind_handoffs").get()).toEqual({
    started_at: at,
    updated_at: at,
    lease_at: at,
  });
});

test("a closing transition cannot overwrite an unfinished outgoing identity", () => {
  using client = new Database(":memory:");
  const db = drizzle(client);
  migrate(db, { migrationsFolder });
  const target = { sourceId: "s", assignment: "a", launchId: "outgoing" };
  expect(recordKindHandoff(db, target, "pr-feedback").tag).toBe("Ok");
  const before = client.serialize();
  expect(recordKindHandoff(db, { ...target, launchId: "foreign" }, "review")).toMatchObject({
    tag: "Err",
    error: { reason: "handoff_running" },
  });
  expect(client.serialize()).toEqual(before);
  client.exec("UPDATE kind_handoffs SET handoff_state = 'done'");
  expect(recordKindHandoff(db, { ...target, launchId: "next" }, "pr-feedback").tag).toBe("Ok");
  expect(client.query("SELECT outgoing_launch_id, next_kind FROM kind_handoffs").get()).toEqual({
    outgoing_launch_id: "next",
    next_kind: "pr-feedback",
  });
});
