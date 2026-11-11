import { and, asc, eq } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import type { Result } from "unthrown";
import { checkHistory, transaction, type Db } from "./database.ts";
import { obligations, sources } from "./schema.ts";
import { controlledSource } from "./sources.ts";

export type ObligationRow = typeof obligations.$inferSelect;
type Target = Parameters<typeof controlledSource>[1];

export type ObligationFacts = {
  source: typeof sources.$inferSelect;
  obligation: ObligationRow | null;
};

export type ObligationChange = {
  insert?: ObligationRow;
  update?: Partial<Omit<ObligationRow, "sourceId" | "key">>;
};

function list(db: Db, sourceId: string) {
  return db
    .select()
    .from(obligations)
    .where(eq(obligations.sourceId, sourceId))
    .orderBy(asc(obligations.openedAt), asc(obligations.key))
    .all();
}

/** The ledger of one source of the project, opened and closed alike. */
export function readObligations(client: Database, target: Target) {
  return transaction(client, false, () =>
    checkHistory(client).flatMap((db) =>
      controlledSource(db, target).map((source) => ({ source, obligations: list(db, source.id) })),
    ),
  );
}

/**
 * Read one obligation, ask the caller's rule for a change, and apply it in one immediate
 * transaction, so two closes or two additions with one key cannot both apply.
 */
export function changeObligation<E extends { reason: string; detail: string }>(
  client: Database,
  target: Target,
  key: string,
  decide: (facts: ObligationFacts) => Result<ObligationChange, E>,
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) =>
      controlledSource(db, target).flatMap((source) => {
        const obligation = db
          .select()
          .from(obligations)
          .where(and(eq(obligations.sourceId, source.id), eq(obligations.key, key)))
          .get();
        const facts = { source, obligation: obligation ?? null };
        return decide(facts).map((change) => {
          if (change.insert) db.insert(obligations).values(change.insert).run();
          if (change.update)
            db.update(obligations)
              .set(change.update)
              .where(and(eq(obligations.sourceId, source.id), eq(obligations.key, key)))
              .run();
          return { facts, change };
        });
      }),
    ),
  );
}
