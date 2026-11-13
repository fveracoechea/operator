import { and, desc, eq } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import { Err, Ok, type Result } from "unthrown";
import { checkHistory, transaction, type Db } from "./database.ts";
import { launches, assignments, sources, workerMessages } from "./schema.ts";
import { locate, type ReportTarget } from "./reports.ts";
import type { StateFailure } from "./failures.ts";

export type MessageRow = typeof workerMessages.$inferSelect;

export type MessageFacts = {
  source: typeof sources.$inferSelect;
  assignment: typeof assignments.$inferSelect;
  launch: typeof launches.$inferSelect | null;
  message: MessageRow | null;
};

export type MessageChange = {
  insert?: MessageRow;
  update?: Partial<Omit<MessageRow, "sourceId" | "assignment" | "key">>;
};

type TargetFailure = StateFailure | { reason: string; detail: string };

function readFacts(db: Db, target: ReportTarget, key: string) {
  return locate(db, target).flatMap(
    ({ sourceId, assignment: name }): Result<MessageFacts, TargetFailure> => {
      const source = db.select().from(sources).where(eq(sources.id, sourceId)).get();
      const assignment = db
        .select()
        .from(assignments)
        .where(and(eq(assignments.sourceId, sourceId), eq(assignments.key, name)))
        .get();
      // Stryker disable next-line ConditionalExpression: equivalent: the source id comes from a located source or from a launch whose foreign key names one
      if (source === undefined || assignment === undefined)
        return Err({
          reason: "assignment_not_found",
          detail: `Assignment ${name} does not exist in this source. Nothing changed.`,
        });
      const launch = db
        .select()
        .from(launches)
        .where(and(eq(launches.sourceId, sourceId), eq(launches.assignment, name)))
        .orderBy(desc(launches.attempt))
        .get();
      return Ok({
        source,
        assignment,
        launch: launch ?? null,
        message: selectMessage(db, sourceId, name, key) ?? null,
      });
    },
  );
}

function selectMessage(db: Db, sourceId: string, assignment: string, key: string) {
  return db
    .select()
    .from(workerMessages)
    .where(
      and(
        eq(workerMessages.sourceId, sourceId),
        eq(workerMessages.assignment, assignment),
        eq(workerMessages.key, key),
      ),
    )
    .get();
}

/** Apply a message change inside a caller's transaction, for the facts of its assignment. */
export function applyMessage(
  db: Db,
  assignment: { sourceId: string; key: string },
  key: string,
  change: MessageChange,
) {
  if (change.insert) db.insert(workerMessages).values(change.insert).run();
  if (change.update)
    db.update(workerMessages)
      .set(change.update)
      .where(
        and(
          eq(workerMessages.sourceId, assignment.sourceId),
          eq(workerMessages.assignment, assignment.key),
          eq(workerMessages.key, key),
        ),
      )
      .run();
}

/** Read the facts that a message command decides from, without a write transaction. */
export function readMessage(client: Database, target: ReportTarget, key: string) {
  return transaction(client, false, () =>
    checkHistory(client).flatMap((db) => readFacts(db, target, key)),
  );
}

/**
 * Read the message's facts, ask the caller's rule for a change, and apply it in one immediate
 * transaction, so an acknowledgement and a close cannot both apply.
 */
export function changeMessage<E extends { reason: string; detail: string }>(
  client: Database,
  target: ReportTarget,
  key: string,
  decide: (facts: MessageFacts) => Result<MessageChange, E>,
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) =>
      readFacts(db, target, key).flatMap(
        (facts): Result<{ facts: MessageFacts; change: MessageChange }, TargetFailure | E> =>
          decide(facts).map((change) => {
            applyMessage(db, facts.assignment, key, change);
            return { facts, change };
          }),
      ),
    ),
  );
}
