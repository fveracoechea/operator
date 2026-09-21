import { eq } from "drizzle-orm";
import type { CrewReader, CrewWriter } from "./database.ts";
import { withdrawQuestions } from "./questions.ts";
import { attempts } from "./schema.ts";

export type AttemptRow = typeof attempts.$inferSelect;

/** How many attempts one assignment has held, including the one running now. */
export function attemptCount(db: CrewReader, assignmentId: string): number {
  return db.select().from(attempts).where(eq(attempts.assignmentId, assignmentId)).all().length;
}

export function readAttempt(db: CrewReader, attemptId: string): AttemptRow | null {
  return db.select().from(attempts).where(eq(attempts.id, attemptId)).all()[0] ?? null;
}

export function startAttempt(
  db: CrewWriter,
  request: { attemptId: string; assignmentId: string; ownerToken: string; now: string },
): void {
  db.insert(attempts)
    .values({
      id: request.attemptId,
      assignmentId: request.assignmentId,
      ownerToken: request.ownerToken,
      state: "active",
      revision: 1,
      startedAt: request.now,
      endedAt: null,
    })
    .run();
}

/**
 * Records the final state of one attempt without ending its assignment.
 * An attempt that already ended, such as one that submitted its result, keeps the time it
 * ended, so a later acceptance does not rewrite when the writing stopped.
 * The questions it raised are withdrawn, because a stopped writer holds none.
 */
export function endAttempt(
  db: CrewWriter,
  request: { attempt: AttemptRow; state: string; now: string },
): void {
  db.update(attempts)
    .set({
      state: request.state,
      endedAt: request.attempt.endedAt ?? request.now,
      revision: request.attempt.revision + 1,
    })
    .where(eq(attempts.id, request.attempt.id))
    .run();

  // An attempt that stopped writing holds no question. A replacement raises its own.
  withdrawQuestions(db, { attemptId: request.attempt.id, now: request.now });
}
