import type { Database } from "bun:sqlite";
import { Err, Ok } from "unthrown";
import type { StateFailure } from "./failures.ts";

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
  return Ok(undefined);
}

export function migrationBlockers(client: Database, timestamp: number) {
  // The first two fixed migrations have no migration-specific held-record blockers.
  const policies: ReadonlyMap<number, readonly string[]> = new Map([
    [1792968033776, []],
    [1793024341510, []],
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
