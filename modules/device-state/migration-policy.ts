import type { Database } from "bun:sqlite";
import { Err, Ok } from "unthrown";
import type { StateFailure } from "./failures.ts";
import { ownerGone } from "./launches.ts";

type Owned = { owner_pid: number | null; lease_at: string | null };

/** A start or preparation whose owner stopped is abandoned, so it does not hold an upgrade. */
function heldBy(client: Database, query: string) {
  const now = Date.now();
  return client
    .query<Owned, []>(query)
    .all()
    .some((row) => !ownerGone({ ownerPid: row.owner_pid, leaseAt: row.lease_at }, now));
}

/** Future workflow owners extend these guards when they add launches, waits, or held records. */
export function idleForMigration(client: Database, applied: number) {
  if (
    applied >= 2 &&
    client
      .query("SELECT 1 FROM assignments WHERE state IN ('running', 'pr-open', 'reported') LIMIT 1")
      .get()
  )
    return Err<StateFailure>({
      reason: "state_migration_blocked",
      detail:
        "Migration is waiting for active assignments across all registered projects to become idle. No handler ran.",
    });
  if (applied >= 3 && client.query("SELECT 1 FROM project_removals LIMIT 1").get())
    return Err<StateFailure>({
      reason: "state_migration_blocked",
      detail: "Finish pending project file cleanup before an upgrade. No handler ran.",
    });
  if (
    applied >= 4 &&
    (client.query("SELECT 1 FROM launches WHERE state = 'running' LIMIT 1").get() ||
      heldBy(client, "SELECT owner_pid, lease_at FROM launches WHERE state = 'starting'") ||
      heldBy(
        client,
        "SELECT owner_pid, lease_at FROM worktree_preparations WHERE state = 'running'",
      ))
  )
    return Err<StateFailure>({
      reason: "state_migration_blocked",
      detail:
        "Migration is waiting for active worker launches and worktree preparations to finish. No handler ran.",
    });
  return Ok(undefined);
}

export function migrationBlockers(client: Database, timestamp: number) {
  // The fixed migrations have no migration-specific held-record blockers.
  const policies: ReadonlyMap<number, readonly string[]> = new Map([
    [1792968033776, []],
    [1793024341510, []],
    [1793031772449, []],
    [1793066920427, []],
    [1793114012060, []],
  ]);
  const queries = policies.get(timestamp);
  if (!queries)
    return Err<StateFailure>({
      reason: "state_incompatible",
      detail: "The shipped migration has no declared blocker policy. No handler ran.",
    });
  for (const query of queries) {
    if (client.query(query).get())
      return Err<StateFailure>({
        reason: "state_migration_blocked",
        detail: "A migration-specific held record blocks startup. No handler ran.",
      });
  }
  return Ok(undefined);
}
