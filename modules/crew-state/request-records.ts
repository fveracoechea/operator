import { eq } from "drizzle-orm";
import type { CrewReader, CrewWriter } from "./database.ts";
import { requestRecords } from "./schema.ts";

export type RequestLookup<Outcome> =
  | { status: "new" }
  | { status: "repeat"; outcome: Outcome }
  | { status: "input-changed"; operation: string };

/**
 * Request identity makes a local retry safe: the recorded outcome comes back with no new effect.
 * The same identity carrying different input is a caller mistake, never a second effect.
 */
export function lookupRequest<Outcome>(
  db: CrewReader,
  request: { requestId: string; operation: string; inputIdentity: string },
): RequestLookup<Outcome> {
  const rows = db
    .select()
    .from(requestRecords)
    .where(eq(requestRecords.id, request.requestId))
    .all();
  const recorded = rows[0];
  if (recorded === undefined) {
    return { status: "new" };
  }

  if (
    recorded.operation !== request.operation ||
    recorded.inputIdentity !== request.inputIdentity
  ) {
    return { status: "input-changed", operation: recorded.operation };
  }

  // The stored text is the JSON of the outcome this same operation and input produced before.
  return { status: "repeat", outcome: JSON.parse(recorded.outcome) as Outcome };
}

export function recordRequest(
  db: CrewWriter,
  request: {
    requestId: string;
    operation: string;
    inputIdentity: string;
    outcome: unknown;
    now: string;
  },
): void {
  db.insert(requestRecords)
    .values({
      id: request.requestId,
      operation: request.operation,
      inputIdentity: request.inputIdentity,
      outcome: JSON.stringify(request.outcome),
      recordedAt: request.now,
    })
    .run();
}
