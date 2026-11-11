import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import { Err, Ok, type Result } from "unthrown";
import { checkHistory, transaction, type Db } from "./database.ts";
import { coordinationWaits, sources } from "./schema.ts";
import { ownerGone } from "./leases.ts";
import type { SourceFailure, Supervisor } from "./sources.ts";

export type CoordinationScope = { repository: string; scope: string };

const sessionPrefix = "session:";

/** The scope of a wait without a source from a session, which covers every source it supervises. */
export function coordinationSessionScope(session: string) {
  return `${sessionPrefix}${session}`;
}

// A project wait and a session wait claim the same sources, and only a source scope names a source.
function unscoped(scope: string) {
  return scope === "" || scope.startsWith(sessionPrefix);
}

/** A change of a stored set: it reads the set or null, and returns the set to store. */
export type SetChange = (stored: string | null) => string;

const missing = {
  reason: "source_not_found",
  detail: "The source does not exist in this project.",
} as const;

function key(target: CoordinationScope) {
  return and(
    eq(coordinationWaits.repository, target.repository),
    eq(coordinationWaits.scope, target.scope),
  );
}

/**
 * Record this process as the running wait of the scope, with its pane and session, and return the
 * set that the scope's last wait returned. A scope that never returned a set has none.
 * The pane and session become the supervisor of the scope's source. A wait without a source claims
 * only the open sources that nobody supervises yet, so it never takes over another's sources.
 * A wait for a source that the project does not have records nothing.
 */
export function startCoordinationWait(
  client: Database,
  target: CoordinationScope,
  supervisor: Supervisor,
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db): Result<string | null, SourceFailure> => {
      const known =
        unscoped(target.scope) ||
        db
          .select({ id: sources.id })
          .from(sources)
          .where(and(eq(sources.repository, target.repository), eq(sources.id, target.scope)))
          .get() !== undefined;
      if (!known) return Err(missing);
      const now = new Date().toISOString();
      const running = {
        ownerPid: process.pid,
        leaseAt: now,
        paneId: supervisor.pane,
        session: supervisor.session,
        startedAt: now,
      };
      const row = db.select().from(coordinationWaits).where(key(target)).get();
      if (row === undefined)
        db.insert(coordinationWaits)
          .values({ ...target, ...running })
          .run();
      else db.update(coordinationWaits).set(running).where(key(target)).run();
      if (supervisor.pane !== null || supervisor.session !== null)
        db.update(sources)
          .set({ supervisingPane: supervisor.pane, supervisingSession: supervisor.session })
          .where(
            and(
              eq(sources.repository, target.repository),
              unscoped(target.scope)
                ? and(
                    eq(sources.state, "open"),
                    isNull(sources.supervisingPane),
                    isNull(sources.supervisingSession),
                  )
                : eq(sources.id, target.scope),
            ),
          )
          .run();
      return Ok(row?.actions ?? null);
    }),
  );
}

/**
 * Merge the set that this wait returns into the stored set, and end the wait unless a later wait
 * replaced it. The change reads the stored set under the writer reservation, so an
 * acknowledgement that a command recorded during the wait stays.
 */
export function finishCoordinationWait(
  client: Database,
  target: CoordinationScope,
  change: SetChange,
) {
  return transaction(client, true, () =>
    checkHistory(client).map((db) => {
      const row = db.select().from(coordinationWaits).where(key(target)).get();
      db.update(coordinationWaits)
        .set({ actions: change(row?.actions ?? null), returnedAt: new Date().toISOString() })
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

/** The set that the scope's waits returned and acknowledged, or null before its first return. */
export function readCoordinationWait(client: Database, target: CoordinationScope) {
  return transaction(client, false, () =>
    checkHistory(client).map(
      (db) => db.select().from(coordinationWaits).where(key(target)).get()?.actions ?? null,
    ),
  );
}

/** Rewrite the stored set of a scope that returned one. A scope without a set stays without. */
export function changeCoordinationWait(
  client: Database,
  target: CoordinationScope,
  change: SetChange,
) {
  return transaction(client, true, () =>
    checkHistory(client).map((db) => {
      const stored = db.select().from(coordinationWaits).where(key(target)).get()?.actions ?? null;
      if (stored === null) return null;
      const changed = change(stored);
      if (changed !== stored)
        db.update(coordinationWaits).set({ actions: changed }).where(key(target)).run();
      return changed;
    }),
  );
}

/**
 * Rewrite the stored set of every wait that the session ran and that returned a set, in every
 * project, so a change that the session made itself does not end its next wait.
 */
export function acknowledgeCoordinationWaits(client: Database, session: string, change: SetChange) {
  return transaction(client, true, () =>
    checkHistory(client).map((db) => {
      const waits = db
        .select()
        .from(coordinationWaits)
        .where(eq(coordinationWaits.session, session))
        .all();
      for (const row of waits) {
        if (row.actions === null) continue;
        db.update(coordinationWaits)
          .set({ actions: change(row.actions) })
          .where(key(row))
          .run();
      }
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

/**
 * The sources that the agent session supervises, each with whether a wait from that session
 * covers it. A wait covers its own source, a project wait covers every source of its project, and
 * the session's own wait covers every source that it supervises. The pane does not count, so a new
 * session in a supervising pane supervises nothing.
 */
export function readSupervision(client: Database, session: string) {
  return transaction(client, false, () =>
    checkHistory(client).map((db) => {
      const now = Date.now();
      const waits = db
        .select()
        .from(coordinationWaits)
        .where(eq(coordinationWaits.session, session))
        .all()
        .filter((row) => !ownerGone(row, now));
      return db
        .select({ id: sources.id, repository: sources.repository })
        .from(sources)
        .where(eq(sources.supervisingSession, session))
        .orderBy(asc(sources.id))
        .all()
        .map((source) => ({
          ...source,
          waiting: waits.some(
            (row) =>
              row.scope === coordinationSessionScope(session) ||
              (row.repository === source.repository &&
                (row.scope === "" || row.scope === source.id)),
          ),
        }));
    }),
  );
}

function sourceOf(db: Db, repository: string, sourceId: string) {
  return db
    .select({ pane: sources.supervisingPane, session: sources.supervisingSession })
    .from(sources)
    .where(and(eq(sources.repository, repository), eq(sources.id, sourceId)))
    .get();
}

/** The pane and session that supervise a source. Both are null before a wait or dispatch claims it. */
export function readSupervisor(client: Database, repository: string, sourceId: string) {
  return transaction(client, false, () =>
    checkHistory(client).flatMap((db): Result<Supervisor, SourceFailure> => {
      const row = sourceOf(db, repository, sourceId);
      return row === undefined ? Err(missing) : Ok(row);
    }),
  );
}

/**
 * Make the caller the supervisor of a source, whoever supervised it before, and return the earlier
 * supervisor. A caller without a session leaves the source to the next wait or dispatch.
 */
export function takeOverSource(
  client: Database,
  repository: string,
  sourceId: string,
  supervisor: Supervisor,
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db): Result<Supervisor, SourceFailure> => {
      const row = sourceOf(db, repository, sourceId);
      if (row === undefined) return Err(missing);
      db.update(sources)
        .set({ supervisingPane: supervisor.pane, supervisingSession: supervisor.session })
        .where(eq(sources.id, sourceId))
        .run();
      return Ok(row);
    }),
  );
}
