import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import { Err, Ok, type Result } from "unthrown";
import { checkHistory, transaction } from "./database.ts";
import { coordinationWaits, sources } from "./schema.ts";
import type { SourceFailure } from "./sources.ts";

export type CoordinationScope = { repository: string; scope: string };

function key(target: CoordinationScope) {
  return and(
    eq(coordinationWaits.repository, target.repository),
    eq(coordinationWaits.scope, target.scope),
  );
}

/**
 * Record this process as the running wait of the scope, with its pane, and return the set that
 * the scope's last wait returned. A scope that never returned a set has none.
 * The pane becomes the supervising pane of the scope's source. A wait without a source claims
 * only the open sources that no pane supervises yet, so it never takes over another's sources.
 * A wait for a source that the project does not have records nothing.
 */
export function startCoordinationWait(
  client: Database,
  target: CoordinationScope,
  paneId: string | null,
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db): Result<string | null, SourceFailure> => {
      const known =
        target.scope === "" ||
        db
          .select({ id: sources.id })
          .from(sources)
          .where(and(eq(sources.repository, target.repository), eq(sources.id, target.scope)))
          .get() !== undefined;
      if (!known)
        return Err({
          reason: "source_not_found",
          detail: "The source does not exist in this project.",
        });
      const now = new Date().toISOString();
      const running = { ownerPid: process.pid, leaseAt: now, paneId, startedAt: now };
      const row = db.select().from(coordinationWaits).where(key(target)).get();
      if (row === undefined)
        db.insert(coordinationWaits)
          .values({ ...target, ...running })
          .run();
      else db.update(coordinationWaits).set(running).where(key(target)).run();
      if (paneId !== null)
        db.update(sources)
          .set({ supervisingPane: paneId })
          .where(
            and(
              eq(sources.repository, target.repository),
              target.scope === ""
                ? and(eq(sources.state, "open"), isNull(sources.supervisingPane))
                : eq(sources.id, target.scope),
            ),
          )
          .run();
      return Ok(row?.actions ?? null);
    }),
  );
}

/** Record the set that this wait returns, and end the wait unless a later wait replaced it. */
export function finishCoordinationWait(
  client: Database,
  target: CoordinationScope,
  actions: string,
) {
  return transaction(client, true, () =>
    checkHistory(client).map((db) => {
      db.update(coordinationWaits)
        .set({ actions, returnedAt: new Date().toISOString() })
        .where(key(target))
        .run();
      db.update(coordinationWaits)
        .set({ ownerPid: null, leaseAt: null })
        .where(and(key(target), eq(coordinationWaits.ownerPid, process.pid)))
        .run();
      return undefined;
    }),
  );
}

/** Renew the lease of a wait that this process runs. */
export function renewCoordinationWait(client: Database, target: CoordinationScope) {
  // Stryker disable next-line BooleanLiteral: equivalent: every path writes, so a deferred begin reaches the same writer reservation before any result
  return transaction(client, true, () =>
    checkHistory(client).map((db) => {
      db.update(coordinationWaits)
        .set({ leaseAt: new Date().toISOString() })
        .where(and(key(target), eq(coordinationWaits.ownerPid, process.pid)))
        .run();
      return undefined;
    }),
  );
}
