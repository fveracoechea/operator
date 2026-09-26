import {
  type AttemptFailure,
  type DispatchReport,
  reportOfContext,
  type Shared,
} from "./dispatch-context.ts";
import { lookupAttempt } from "./dispatch.ts";
import { readState } from "./operations.ts";

export type ShowResult =
  | {
      status: "reported";
      report: DispatchReport;
      acknowledgedAt: string | null;
      current: boolean;
    }
  | { status: "not-dispatched"; attemptId: string }
  | AttemptFailure
  | Shared;

/** Reports the recorded launch of one attempt. It is a read anyone may run. */
export async function showAttempt(request: {
  projectRoot: string;
  attemptId: string;
}): Promise<ShowResult> {
  // A report describes a stale attempt instead of refusing it, because recovery reads it first.
  const read = await readState(request.projectRoot, (db) => lookupAttempt(db, request.attemptId));
  if (read.status !== "ok") {
    return read;
  }
  if (read.context.dispatch === null) {
    return { status: "not-dispatched", attemptId: request.attemptId };
  }

  return {
    status: "reported",
    report: reportOfContext(read.context, read.context.dispatch),
    acknowledgedAt: read.context.dispatch.acknowledgedAt,
    current: read.context.current,
  };
}
