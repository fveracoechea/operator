import type { Database } from "bun:sqlite";
import { Err, Ok } from "unthrown";
import type { StateFailure } from "./failures.ts";
import { ownerGone } from "./leases.ts";

type Owned = { owner_pid: number | null; lease_at: string | null };

/** A start or preparation whose owner stopped is abandoned, so it does not hold an upgrade. */
function heldBy(client: Database, query: string) {
  const now = Date.now();
  return client
    .query<Owned, []>(query)
    .all()
    .some((row) => !ownerGone({ ownerPid: row.owner_pid, leaseAt: row.lease_at }, now));
}

function found(client: Database, query: string) {
  return Boolean(client.query(query).get());
}

/** Each guard applies once the migration that adds its records has run. */
const idleGuards: { applied: number; busy: (client: Database) => boolean; detail: string }[] = [
  {
    applied: 2,
    busy: (client) =>
      found(
        client,
        "SELECT 1 FROM assignments WHERE state IN ('running', 'pr-open', 'reported') LIMIT 1",
      ),
    detail:
      "Migration is waiting for active assignments across all registered projects to become idle. No handler ran.",
  },
  {
    applied: 3,
    busy: (client) => found(client, "SELECT 1 FROM project_removals LIMIT 1"),
    detail: "Finish pending project file cleanup before an upgrade. No handler ran.",
  },
  {
    applied: 4,
    busy: (client) =>
      found(client, "SELECT 1 FROM launches WHERE state = 'running' LIMIT 1") ||
      heldBy(client, "SELECT owner_pid, lease_at FROM launches WHERE state = 'starting'") ||
      heldBy(
        client,
        "SELECT owner_pid, lease_at FROM worktree_preparations WHERE state = 'running'",
      ),
    detail:
      "Migration is waiting for active worker launches and worktree preparations to finish. No handler ran.",
  },
  {
    applied: 7,
    busy: (client) =>
      heldBy(client, "SELECT owner_pid, lease_at FROM cleanups WHERE owner_pid IS NOT NULL"),
    detail: "Migration is waiting for a running cleanup to finish. No handler ran.",
  },
  // A reviewer works toward a post, and a start or a post holds its external effects.
  {
    applied: 9,
    busy: (client) =>
      found(client, "SELECT 1 FROM review_requests WHERE state = 'reviewing' LIMIT 1") ||
      heldBy(
        client,
        "SELECT owner_pid, lease_at FROM review_requests WHERE state = 'posting' OR launch_state = 'starting'",
      ),
    detail:
      "Migration is waiting for active reviewers, reviewer starts, and review posts to finish. No handler ran.",
  },
  // A wait that moves a reviewer, or a reviewer cleanup, holds external effects too.
  {
    applied: 10,
    busy: (client) =>
      heldBy(client, "SELECT owner_pid, lease_at FROM review_requests WHERE owner_pid IS NOT NULL"),
    detail:
      "Migration is waiting for a reviewer move or a reviewer cleanup to finish. No handler ran.",
  },
];

/** Future workflow owners extend these guards when they add launches, waits, or held records. */
export function idleForMigration(client: Database, applied: number) {
  const guard = idleGuards.find((row) => applied >= row.applied && row.busy(client));
  return guard === undefined
    ? Ok(undefined)
    : Err<StateFailure>({ reason: "state_migration_blocked", detail: guard.detail });
}

/** The fixed migrations have no migration-specific held-record blockers. */
const shippedPolicies: ReadonlyMap<number, readonly string[]> = new Map([
  [1792968033776, []],
  [1793024341510, []],
  [1793031772449, []],
  [1793066920427, []],
  [1793114012060, []],
  [1793115655370, []],
  [1793118895818, []],
  [1793121866694, []],
  [1793126345841, []],
  [1793127419030, []],
  [1793140707700, []],
]);

/** Each policy names queries that find records the migration must not run past. */
export function migrationBlockers(client: Database, timestamp: number, policies = shippedPolicies) {
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
