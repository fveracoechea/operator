import { and, desc, eq } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import { Err, Ok, type Result } from "unthrown";
import { checkHistory, transaction, type Db } from "./database.ts";
import { launches, assignments, sources, workerQuestions } from "./schema.ts";
import { locate, type ReportTarget } from "./reports.ts";
import type { StateFailure } from "./failures.ts";
import type { ResultContext } from "../../lib/cli-result.ts";
import { applyMessage, type MessageRow } from "./messages.ts";

export type QuestionRow = typeof workerQuestions.$inferSelect;

export type QuestionFacts = {
  source: typeof sources.$inferSelect;
  assignment: typeof assignments.$inferSelect;
  launch: typeof launches.$inferSelect | null;
  question: QuestionRow | null;
};

export type QuestionChange = {
  insert?: QuestionRow;
  update?: Partial<Omit<QuestionRow, "sourceId" | "assignment" | "key">>;
  /** The steering message that delivers an answer, recorded in the same transaction. */
  message?: MessageRow;
};

type TargetFailure = StateFailure | (ResultContext & { reason: string; detail: string });

function readFacts(db: Db, target: ReportTarget, key: string) {
  return locate(db, target).flatMap(
    ({ sourceId, assignment: name }): Result<QuestionFacts, TargetFailure> => {
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
          next: {
            command: "operator next",
            why: "Read the available assignments before choosing a target.",
          },
          state: { sourceExists: source !== undefined, assignmentExists: assignment !== undefined },
          detail: `Assignment ${name} does not exist in this source. Nothing changed.`,
        });
      const launch = db
        .select()
        .from(launches)
        .where(and(eq(launches.sourceId, sourceId), eq(launches.assignment, name)))
        .orderBy(desc(launches.attempt))
        .get();
      const question = db
        .select()
        .from(workerQuestions)
        .where(
          and(
            eq(workerQuestions.sourceId, sourceId),
            eq(workerQuestions.assignment, name),
            eq(workerQuestions.key, key),
          ),
        )
        .get();
      return Ok({ source, assignment, launch: launch ?? null, question: question ?? null });
    },
  );
}

/** Read the facts that a question command decides from, without a write transaction. */
export function readQuestion(client: Database, target: ReportTarget, key: string) {
  return transaction(client, false, () =>
    checkHistory(client).flatMap((db) => readFacts(db, target, key)),
  );
}

/**
 * Read the question's facts, ask the caller's rule for a change, and apply it in one immediate
 * transaction, so two answers or an answer and a withdrawal cannot both apply.
 */
export function changeQuestion<E extends { reason: string; detail: string }>(
  client: Database,
  target: ReportTarget,
  key: string,
  decide: (facts: QuestionFacts) => Result<QuestionChange, E>,
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db) =>
      readFacts(db, target, key).flatMap(
        (facts): Result<{ facts: QuestionFacts; change: QuestionChange }, TargetFailure | E> =>
          decide(facts).map((change) => {
            if (change.insert) db.insert(workerQuestions).values(change.insert).run();
            if (change.update)
              db.update(workerQuestions)
                .set(change.update)
                .where(
                  and(
                    eq(workerQuestions.sourceId, facts.assignment.sourceId),
                    eq(workerQuestions.assignment, facts.assignment.key),
                    eq(workerQuestions.key, key),
                  ),
                )
                .run();
            if (change.message)
              applyMessage(db, facts.assignment, change.message.key, { insert: change.message });
            return { facts, change };
          }),
      ),
    ),
  );
}
