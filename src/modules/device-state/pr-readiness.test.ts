import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { migrationsFolder } from "./database.ts";
import { insertRow } from "./state-fixture.ts";
import { prReadinessSchema, storedPrReadinessSchema, recordPrReady } from "./pr-readiness.ts";

test("readiness retains legacy facts and accepts unknown heads only with explicit migration origin", () => {
  const ready = { head: "known", at: "then", note: "/notes/ready.md", dispositions: [] };
  expect(prReadinessSchema.parse(ready)).toEqual(ready);
  expect(prReadinessSchema.safeParse({ ...ready, head: null }).success).toBe(false);
  expect(prReadinessSchema.parse({ ...ready, head: null, origin: "migration-0026" })).toEqual({
    ...ready,
    head: null,
    origin: "migration-0026",
  });
});

test("readiness records complete dispositions and replaces only the completed outgoing handoff", () => {
  using client = new Database(":memory:");
  migrate(drizzle(client), { migrationsFolder });
  insertRow(client, "pull_requests", { source_id: "s", assignment: "a", readiness: null });
  insertRow(client, "kind_handoffs", {
    source_id: "s",
    assignment: "a",
    outgoing_launch_id: "implementation",
    next_kind: "review",
    handoff_state: "done",
    owner_pid: null,
    lease_at: null,
  });
  const target = { sourceId: "s", assignment: "a", launchId: "reviewer" };
  const ready = {
    head: "pushed-head",
    at: "2026-11-17T12:00:00.000Z",
    note: "/device/reviewer.md",
    dispositions: [
      { round: 1, finding: 1, disposition: "applied" as const },
      {
        round: 2,
        finding: 1,
        disposition: "declined" as const,
        reason: "The existing guard covers this.",
      },
    ],
  };
  expect(recordPrReady(drizzle(client), target, ready, "pr-feedback").tag).toBe("Ok");
  expect(client.query("SELECT readiness FROM pull_requests").get()).toEqual({
    readiness: JSON.stringify(ready),
  });
  expect(
    client
      .query(
        "SELECT outgoing_launch_id, next_kind, handoff_state, owner_pid, started_at FROM kind_handoffs",
      )
      .get(),
  ).toEqual({
    outgoing_launch_id: "reviewer",
    next_kind: "pr-feedback",
    handoff_state: "pending",
    owner_pid: process.pid,
    started_at: "2026-11-17T12:00:00.000Z",
  });
  const before = client.serialize();
  expect(recordPrReady(drizzle(client), target, ready, "pr-feedback")).toMatchObject({
    tag: "Err",
    error: { reason: "handoff_running" },
  });
  expect(client.serialize()).toEqual(before);
  expect(
    prReadinessSchema.safeParse({
      ...ready,
      dispositions: [{ round: 1, finding: 1, disposition: "declined", reason: " " }],
    }).success,
  ).toBe(false);
});

test("persisted dispositions keep tolerant decoding, trimmed reasons and positive identifiers", () => {
  const schema = prReadinessSchema.options[1].shape.dispositions.element;
  expect(
    schema.parse({
      round: 2,
      finding: 3,
      disposition: "declined",
      reason: "  Covered.  ",
      extra: "old metadata",
    }),
  ).toEqual({
    round: 2,
    finding: 3,
    disposition: "declined",
    reason: "Covered.",
  });
  expect(schema.safeParse({ round: 0, finding: 1, disposition: "applied" }).success).toBe(false);
  expect(schema.safeParse({ round: 1, finding: 0, disposition: "applied" }).success).toBe(false);
  expect(
    schema.safeParse({ round: 1, finding: 1, disposition: "declined", reason: " " }).success,
  ).toBe(false);
});

test("stored readiness decodes absent and historical receipts with the same disposition rules", () => {
  expect(storedPrReadinessSchema.parse(null)).toBeNull();
  expect(storedPrReadinessSchema.parse(undefined)).toBeNull();
  expect(
    storedPrReadinessSchema.parse(
      JSON.stringify({
        head: "legacy-ready-head",
        at: "now",
        note: "/device/reviewer.md",
        dispositions: [
          { round: 2, finding: 3, disposition: "declined", reason: "  Covered.  ", extra: true },
        ],
        extra: "old metadata",
      }),
    ),
  ).toEqual({
    head: "legacy-ready-head",
    at: "now",
    note: "/device/reviewer.md",
    dispositions: [{ round: 2, finding: 3, disposition: "declined", reason: "Covered." }],
  });
});

test.each(["{", "{}", "", "null"])("stored readiness refuses corrupt text %j", (text) => {
  expect(() => storedPrReadinessSchema.parse(text)).toThrow();
});
