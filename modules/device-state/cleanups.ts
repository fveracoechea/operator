import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import { Err, Ok, type Result } from "unthrown";
import { checkHistory, transaction } from "./database.ts";
import { ownerGone } from "./launches.ts";
import { cleanups, launches, projects, pullRequests, sources } from "./schema.ts";
import type { StateFailure } from "./failures.ts";

export type CleanupRow = typeof cleanups.$inferSelect;
export type CleanupFailure =
  | StateFailure
  | {
      reason: "source_not_found" | "cleanup_not_found" | "cleanup_running";
      detail: string;
    };
type Claimed = {
  cleanup: CleanupRow;
  pullRequest: typeof pullRequests.$inferSelect;
  launch: typeof launches.$inferSelect;
  checkout: string;
};

function key(sourceId: string, assignment: string) {
  return and(eq(cleanups.sourceId, sourceId), eq(cleanups.assignment, assignment));
}

/**
 * One process at a time runs a cleanup. The claim records this process and its lease, so a
 * second invocation refuses and a stopped one becomes visible as stopped in next actions.
 * A finished cleanup is returned without a claim.
 */
export function claimCleanup(
  client: Database,
  repository: string,
  sourceId: string,
  assignment: string,
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db): Result<Claimed, CleanupFailure> => {
      const source = db
        .select()
        .from(sources)
        .where(and(eq(sources.id, sourceId), eq(sources.repository, repository)))
        .get();
      if (source === undefined)
        return Err({
          reason: "source_not_found",
          detail: "The source does not exist in this project.",
        });
      const cleanup = db.select().from(cleanups).where(key(sourceId, assignment)).get();
      const pullRequest = db
        .select()
        .from(pullRequests)
        .where(and(eq(pullRequests.sourceId, sourceId), eq(pullRequests.assignment, assignment)))
        .get();
      const launch =
        cleanup === undefined
          ? undefined
          : db.select().from(launches).where(eq(launches.id, cleanup.launchId)).get();
      const project = db.select().from(projects).where(eq(projects.repository, repository)).get();
      if (
        cleanup === undefined ||
        pullRequest === undefined ||
        launch === undefined ||
        project === undefined
      )
        return Err({
          reason: "cleanup_not_found",
          detail: `Assignment ${assignment} has no cleanup. Only a verified merge records one. Nothing was changed.`,
        });
      const facts = { pullRequest, launch, checkout: project.checkout };
      if (cleanup.state === "done") return Ok({ cleanup, ...facts });
      // The merge records its cleanup process at start, so that process may take its own claim.
      if (
        cleanup.ownerPid !== null &&
        cleanup.ownerPid !== process.pid &&
        !ownerGone(cleanup, Date.now())
      )
        return Err({
          reason: "cleanup_running",
          detail: `Process ${cleanup.ownerPid} is still cleaning up assignment ${assignment}. Read operator next later. Nothing was changed.`,
        });
      const now = new Date().toISOString();
      const claimed = { ...cleanup, ownerPid: process.pid, leaseAt: now };
      db.update(cleanups).set(claimed).where(key(sourceId, assignment)).run();
      return Ok({ cleanup: claimed, ...facts });
    }),
  );
}

/**
 * Records the process that a merge started for its new cleanup, so next shows it running
 * before that process claims it. A cleanup that a process already claimed or ended stays.
 */
export function startCleanup(client: Database, sourceId: string, assignment: string, pid: number) {
  return transaction(client, true, () =>
    checkHistory(client).map((db) => {
      db.update(cleanups)
        .set({ ownerPid: pid, leaseAt: new Date().toISOString() })
        .where(
          and(
            key(sourceId, assignment),
            isNull(cleanups.ownerPid),
            eq(cleanups.state, "pending"),
            eq(cleanups.step, "remote_branch"),
          ),
        )
        .run();
      return undefined;
    }),
  );
}

/** Records the outcome of one step. Only the claiming process can advance its cleanup. */
export function advanceCleanup(
  client: Database,
  sourceId: string,
  assignment: string,
  change: Pick<CleanupRow, "step" | "state" | "reason" | "detail"> & { release: boolean },
) {
  return transaction(client, true, () =>
    checkHistory(client).map((db) => {
      const { release, ...outcome } = change;
      const row: Partial<CleanupRow> = { ...outcome, updatedAt: new Date().toISOString() };
      if (release) {
        row.ownerPid = null;
        row.leaseAt = null;
      }
      db.update(cleanups)
        .set(row)
        .where(and(key(sourceId, assignment), eq(cleanups.ownerPid, process.pid)))
        .run();
      return undefined;
    }),
  );
}

/** Renew the lease of a cleanup that this process runs. */
export function renewCleanup(client: Database, sourceId: string, assignment: string) {
  return transaction(client, true, () =>
    checkHistory(client).map((db) => {
      db.update(cleanups)
        .set({ leaseAt: new Date().toISOString() })
        .where(and(key(sourceId, assignment), eq(cleanups.ownerPid, process.pid)))
        .run();
      return undefined;
    }),
  );
}
