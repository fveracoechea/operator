import {
  type CrewDatabase,
  type CrewWriter,
  createState,
  type OpenResult,
  openState,
} from "./database.ts";
import { identityOf } from "./identity.ts";
import { type Ownership, requireOwnership } from "./ownership.ts";
import { lookupRequest, recordRequest } from "./request-records.ts";

export type StateFailure =
  | { status: "state-missing"; path: string }
  | { status: "state-unreadable"; path: string; detail: string }
  | { status: "state-unsupported"; path: string; found: number; supported: number };

export type RequestFailure =
  | { status: "request-input-changed"; requestId: string; recordedOperation: string }
  | { status: "unowned" }
  | { status: "ownership-stale"; ownership: Ownership };

export type MutationRequest = {
  projectRoot: string;
  requestId: string;
  ownerToken: string | null;
  now: string;
};

/** A body commits only the outcome it declares final; every other outcome leaves no effect. */
type Body<Outcome> = (context: { tx: CrewWriter; ownership: Ownership | null; now: string }) => {
  commit: boolean;
  outcome: Outcome;
};

function stateFailure(opened: Exclude<OpenResult, { status: "open" }>): StateFailure {
  if (opened.status === "missing") {
    return { status: "state-missing", path: opened.path };
  }
  if (opened.status === "unreadable") {
    return { status: "state-unreadable", path: opened.path, detail: opened.detail };
  }

  return {
    status: "state-unsupported",
    path: opened.path,
    found: opened.found,
    supported: opened.supported,
  };
}

async function acquire(projectRoot: string, create: boolean, now: string) {
  if (create) {
    const created = await createState(projectRoot, now);
    if (created.status !== "exists") {
      return created;
    }
  }

  return openState(projectRoot);
}

/**
 * Runs one mutation under the four preconditions every mutation shares: request identity,
 * unchanged input under that identity, the current record revision, and live crew ownership.
 * An immediate transaction makes two Operator processes serialize instead of interleave.
 */
export async function mutate<Outcome extends { status: string }>(
  request: MutationRequest & { operation: string; input: unknown; create?: boolean },
  body: Body<Outcome>,
): Promise<{ repeated: boolean; result: Outcome | StateFailure | RequestFailure }> {
  const opened = await acquire(request.projectRoot, request.create === true, request.now);
  if (opened.status !== "open") {
    return { repeated: false, result: stateFailure(opened) };
  }

  const inputIdentity = identityOf(request.input);
  const held: {
    reported: { repeated: boolean; result: Outcome | StateFailure | RequestFailure } | null;
  } = { reported: null };

  try {
    return opened.db.transaction(
      (tx) => {
        const recorded = lookupRequest<Outcome>(tx, {
          requestId: request.requestId,
          operation: request.operation,
          inputIdentity,
        });
        if (recorded.status === "input-changed") {
          held.reported = {
            repeated: false,
            result: {
              status: "request-input-changed",
              requestId: request.requestId,
              recordedOperation: recorded.operation,
            },
          };
          tx.rollback();
        }
        if (recorded.status === "repeat") {
          held.reported = { repeated: true, result: recorded.outcome };
          tx.rollback();
        }

        let ownership: Ownership | null = null;
        if (request.ownerToken !== null) {
          const check = requireOwnership(tx, request.ownerToken);
          if (check.status !== "ok") {
            held.reported = {
              repeated: false,
              result:
                check.status === "unowned"
                  ? { status: "unowned" }
                  : { status: "ownership-stale", ownership: check.ownership },
            };
            tx.rollback();
          } else {
            ownership = check.ownership;
          }
        }

        const done = body({ tx, ownership, now: request.now });
        if (!done.commit) {
          held.reported = { repeated: false, result: done.outcome };
          tx.rollback();
        }

        recordRequest(tx, {
          requestId: request.requestId,
          operation: request.operation,
          inputIdentity,
          outcome: done.outcome,
          now: request.now,
        });
        return { repeated: false, result: done.outcome };
      },
      { behavior: "immediate" },
    );
  } catch (error) {
    if (held.reported !== null) {
      return held.reported;
    }
    throw error;
  } finally {
    opened.close();
  }
}

/** Opens crew state for a read. Reads never create, repair, or replace the file. */
export async function readState<Outcome>(
  projectRoot: string,
  body: (db: CrewDatabase) => Outcome,
): Promise<Outcome | StateFailure> {
  const opened = await openState(projectRoot);
  if (opened.status !== "open") {
    return stateFailure(opened);
  }

  try {
    return body(opened.db);
  } finally {
    opened.close();
  }
}
