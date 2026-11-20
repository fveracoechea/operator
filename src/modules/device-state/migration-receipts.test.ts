import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  beforeKindsMigration,
  historicalAssignment,
  migrateKinds,
} from "./kind-migration-fixture.ts";
import { migrationResume, historicalLaunchIdle } from "./migration-receipts.ts";
import { resumeParkedPullRequest } from "./pr-parking.ts";
import { launches } from "./schema.ts";
import { reserveLaunch } from "./launches.ts";

test("the first migration-origin resume preserves an interrupted historical launch and cannot authorize a live lease", () => {
  using client = beforeKindsMigration();
  historicalAssignment(client, { key: "old" });
  const history = client.query("SELECT * FROM launches").all();
  migrateKinds(client);
  const db = drizzle(client);
  const launch = db.select().from(launches).get();
  expect(launch?.kind).toBeNull();
  const receipt = {
    origin: "migration-0026",
    launchId: "launch-old",
    head: null,
    at: "then",
    note: null,
    state: "resuming" as const,
    events: ['{"kind":"feedback"}'],
  };
  expect(migrationResume(db, launch, receipt)).toBe(true);
  expect(migrationResume(db, launch, { ...receipt, origin: undefined })).toBe(false);
  expect(migrationResume(db, launch, { ...receipt, events: [] })).toBe(false);
  expect(migrationResume(db, launch, { ...receipt, launchId: "other" })).toBe(false);
  client
    .query("UPDATE pull_requests SET parking = ?")
    .run(JSON.stringify({ ...receipt, state: "parked" }));
  const target = { sourceId: "source", repository: "example/one", assignment: "old" };
  expect(resumeParkedPullRequest(client, target)).toMatchObject({ tag: "Ok" });
  expect(client.query("SELECT * FROM launches").all()).toEqual(history);
  client
    .query(
      "INSERT INTO kind_handoffs (source_id, assignment, outgoing_launch_id, next_kind, handoff_state, started_at, updated_at, owner_pid, lease_at) VALUES ('source', 'old', 'launch-old', 'pr-feedback', 'pending', 'then', 'then', ?, ?)",
    )
    .run(process.pid, new Date().toISOString());
  expect(migrationResume(db, launch, receipt)).toBe(false);
  if (launch !== undefined) {
    expect(historicalLaunchIdle(db, launch)).toBe(false);
    const before = client.serialize();
    expect(
      reserveLaunch(client, "/synthetic", "example/one", {
        ...launch,
        id: "fresh",
        name: "fresh",
        state: "starting",
      }),
    ).toMatchObject({ tag: "Err", error: { reason: "assignment_not_dispatchable" } });
    expect(client.serialize()).toEqual(before);
  }
  client.exec("DELETE FROM kind_handoffs; UPDATE launches SET state = 'running'");
  expect(migrationResume(db, db.select().from(launches).get(), receipt)).toBe(false);
});
