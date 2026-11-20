import { expect, test } from "bun:test";
import {
  beforeKindsMigration,
  historicalAssignment,
  migrateKinds,
} from "./kind-migration-fixture.ts";
import { idleForMigration } from "./migration-policy.ts";
import { prReadinessSchema } from "./pr-readiness.ts";
import { prParkingSchema } from "./pr-parking.ts";

test("the migration maps in-flight records to kinds from recorded facts only", () => {
  using client = beforeKindsMigration();
  const cases = [
    { key: "planned", state: "ready", pr: false, expected: "implementation" },
    { key: "running", state: "running", pr: false, expected: "implementation" },
    { key: "reviewing", review: "reviewing", handoff: "done", expected: "review" },
    { key: "pending", review: "ready", handoff: "pending", expected: "review" },
    { key: "failed", review: "skipped", handoff: "failed", expected: "review" },
    {
      key: "ready",
      review: "ready",
      handoff: "done",
      nextKind: "pr-feedback",
      expected: "pr-feedback",
    },
    { key: "skipped", review: "skipped", handoff: "done", expected: "pr-feedback" },
    { key: "none", expected: "pr-feedback" },
    { key: "adopt", state: "ready", pr: false, expected: null },
    { key: "report-ready", state: "ready", completion: "report", pr: false, expected: null },
    { key: "report-running", state: "running", completion: "report", pr: false, expected: null },
    { key: "report-submitted", state: "reported", completion: "report", pr: false, expected: null },
    { key: "ended", state: "abandoned", expected: null },
    { key: "merged", state: "merged", expected: null },
    { key: "cleanup", cleanup: true, review: "reviewing", expected: null },
    { key: "resolved", kind: "implementation", expected: "implementation" },
    { key: "resolved-feedback", kind: "pr-feedback", expected: "pr-feedback" },
    { key: "legacy-failed", review: "ready", expected: "review" },
  ];
  for (const row of cases) historicalAssignment(client, row);
  const plan = '{"assignments":[{"key":"adopt","adopt":7}]}';
  client.query("UPDATE sources SET plan = ?").run(plan);
  const launches = client.query("SELECT * FROM launches").all();
  const reviews = client.query("SELECT * FROM internal_reviews").all();
  const handoffs = client.query("SELECT * FROM kind_handoffs").all();
  migrateKinds(client);
  for (const row of cases)
    expect(
      client.query("SELECT kind FROM assignments WHERE key = ?").get(row.key),
      row.key,
    ).toEqual({ kind: row.expected });
  expect(client.query("SELECT plan FROM sources").get()).toEqual({ plan });
  expect(client.query("SELECT * FROM launches").all()).toEqual(launches);
  expect(client.query("SELECT * FROM internal_reviews").all()).toEqual(reviews);
  expect(client.query("SELECT * FROM kind_handoffs").all()).toEqual(handoffs);
  const receipts = client
    .query<{ readiness: string | null; parking: string | null }, []>(
      "SELECT readiness, parking FROM pull_requests WHERE assignment = 'none'",
    )
    .get();
  expect(prReadinessSchema.parse(JSON.parse(receipts?.readiness ?? "null"))).toEqual({
    origin: "migration-0026",
    head: null,
    at: "then",
    note: null,
    dispositions: [],
  });
  expect(prParkingSchema.parse(JSON.parse(receipts?.parking ?? "null"))).toEqual({
    origin: "migration-0026",
    head: null,
    launchId: "launch-none",
    at: "then",
    note: null,
    state: "parked",
    events: [],
    parentSeen: false,
  });
  expect(
    client
      .query("SELECT readiness, parking FROM pull_requests WHERE assignment = 'resolved-feedback'")
      .get(),
  ).toEqual({ readiness: null, parking: null });
  expect(client.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("the migration runs while assignments are running, pr-open, or reported with no live process", () => {
  using client = beforeKindsMigration();
  historicalAssignment(client, { key: "running", state: "running", pr: false });
  historicalAssignment(client, { key: "open" });
  historicalAssignment(client, {
    key: "report",
    state: "reported",
    completion: "report",
    pr: false,
  });
  expect(idleForMigration(client, 26).tag).toBe("Ok");
  migrateKinds(client);
  expect(client.query("SELECT key, kind FROM assignments ORDER BY key").all()).toEqual([
    { key: "open", kind: "pr-feedback" },
    { key: "report", kind: null },
    { key: "running", kind: "implementation" },
  ]);
});

test.each(["finished", "reset"])(
  "the migration excludes a %s source without changing assignments or PR receipts",
  (state) => {
    using client = beforeKindsMigration();
    historicalAssignment(client, { key: "planned", state: "ready", pr: false });
    historicalAssignment(client, { key: "running", state: "running", pr: false });
    historicalAssignment(client, { key: "open" });
    client.query("UPDATE sources SET state = ?, ended_at = 'later' WHERE id = 'source'").run(state);
    const assignments = client.query("SELECT * FROM assignments ORDER BY key").all();
    const prs = client.query("SELECT * FROM pull_requests").all();
    const launches = client.query("SELECT * FROM launches ORDER BY id").all();
    migrateKinds(client);
    expect(client.query("SELECT * FROM assignments ORDER BY key").all()).toEqual(assignments);
    expect(client.query("SELECT * FROM pull_requests").all()).toEqual(prs);
    expect(client.query("SELECT * FROM launches ORDER BY id").all()).toEqual(launches);
    expect(client.query("PRAGMA foreign_key_check").all()).toEqual([]);
  },
);
