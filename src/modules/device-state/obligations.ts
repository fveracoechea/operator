import { and, asc, eq } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import { Err, Ok, type Result } from "unthrown";
import { checkHistory, transaction, type Db } from "./database.ts";
import { obligations, sources, deliveries, launches } from "./schema.ts";
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
        return decide(facts).flatMap((change) => {
          if (
            change.insert?.kind === "merge-hold" &&
            db
              .select({
                ownerPid: deliveries.ownerPid,
                leaseAt: deliveries.leaseAt,
                endedAt: deliveries.endedAt,
              })
              .from(deliveries)
              .innerJoin(launches, eq(launches.id, deliveries.launchId))
              .where(eq(launches.sourceId, source.id))
              .all()
              .some((row) => row.endedAt === null)
          )
            return Err({
              reason: "pr_delivery_running",
              detail:
                "A delivery is already in flight, so a new hold cannot stop it. Wait for its observed result before recording another hold. Nothing changed.",
              next: {
                decider: "super-agent" as const,
                question:
                  "How should the person's hold be reconciled with the delivery already in flight?",
              },
            });
          if (change.insert) db.insert(obligations).values(change.insert).run();
          if (change.update)
            db.update(obligations)
              .set(change.update)
              .where(and(eq(obligations.sourceId, source.id), eq(obligations.key, key)))
              .run();
          return Ok({ facts, change });
        });
      }),
    ),
  );
}
