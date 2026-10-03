import { OperativeDispatch } from "../operative-dispatch/main.ts";
import { readDispatchRow } from "./dispatch.ts";
import { type InvalidInput, parseInput } from "./input.ts";
import { mutate, readState, type RequestFailure, type StateFailure } from "./operations.ts";
import {
  disposeOutsideChanges,
  type OutsideDisposeOutcome,
  outsideDispositionInputSchema,
  type OutsideScan,
} from "./outside-changes.ts";
import { readSubmission } from "./submission.ts";

type Reported = {
  repeated: boolean;
  result: OutsideDisposeOutcome | InvalidInput | StateFailure | RequestFailure;
};

/**
 * Records what the Operator decided about the outside changes of one submission.
 * A removal is proven by a new scan, taken before the transaction, because the scan reads the
 * disk and the decision is recorded only from what that scan found.
 */
export async function disposeOutside(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  submissionId: string;
  input: unknown;
}): Promise<Reported> {
  const parsed = parseInput(outsideDispositionInputSchema, request.input);
  if (parsed.status !== "parsed") {
    return { repeated: false, result: parsed };
  }
  const input = parsed.value;

  const located = await readState(request.projectRoot, (db) => {
    const submission = readSubmission(db, request.submissionId);
    return submission === null ? null : readDispatchRow(db, submission.attemptId);
  });
  if (located !== null && "status" in located) {
    return { repeated: false, result: located };
  }

  let scan: OutsideScan | null = null;
  if (located !== null && input.dispositions.some((one) => one.disposition === "removed")) {
    scan = await OperativeDispatch.scanOutside({
      projectRoot: request.projectRoot,
      worktreePath: located.worktreePath,
    });
  }

  return mutate<OutsideDisposeOutcome>(
    {
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: request.ownerToken,
      now: new Date().toISOString(),
      operation: "work_dispose",
      input: { submissionId: request.submissionId, dispositions: input.dispositions },
    },
    ({ tx, now }) => {
      const submission = readSubmission(tx, request.submissionId);
      if (submission === null) {
        return {
          commit: false,
          outcome: { status: "unknown-submission", submissionId: request.submissionId },
        };
      }
      const outcome = disposeOutsideChanges(tx, { submission, input, scan, now });
      return { commit: outcome.status === "disposed", outcome };
    },
  );
}
