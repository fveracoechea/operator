import { z } from "zod";
import { type ApprovalRow, approvalCovers } from "./approvals.ts";
import { readStoredValue } from "./stored.ts";
import {
  sentWrites,
  type TrackerOperationRow,
  type TrackerStep as StepName,
  type TrackerTarget,
  type TrackerWriteRow,
} from "./tracker.ts";
import { storedReason } from "./tracker-input.ts";

/** The name of one step. The same name is the machine that moves it. */
export type TrackerStep = StepName;

const recordedState = z.enum([
  "intended",
  "pending",
  "verified",
  "conflict",
  "uncertain",
  "failed",
]);

/**
 * The tracker step machine (ADR 0009, ADR 0023). One `tracker_operations` row moves through
 * these states, and an assignment with no row for a step holds it `unrecorded`. A plan opens the
 * row as `intended`, and each reading of the tracker settles it to one verdict.
 */
export type TrackerStepState = "unrecorded" | z.infer<typeof recordedState>;

/** What settles one recorded step. No exit code alone authorizes any of these. */
export type TrackerStepAction = "record" | "recover" | "approved-write" | "user";

/** What each state offers next. A verified step is finished, and a conflict is a person's call. */
const ACTIONS: Record<TrackerStepState, TrackerStepAction[]> = {
  unrecorded: ["record"],
  intended: ["recover", "record"],
  pending: ["recover", "record"],
  verified: [],
  conflict: ["user"],
  uncertain: ["recover", "approved-write"],
  failed: ["record"],
};

/**
 * The stages of the record event, in the order ADR 0009 runs them. `open` opens or resumes the
 * operation, `observe` and `gate` read the tracker before a write and judge that reading, and
 * `write` sends one write that is then settled from what the tracker shows. The recover and
 * observe events only read and settle, so they decide nothing.
 */
export type TrackerStage = "open" | "observe" | "gate" | "write";

/** The values each stage reads. The caller gathers them, and some cross from the stage before. */
export type TrackerStageFacts = {
  /** The operation the step holds, and the identity of the intent the caller states now. */
  open: { operation: TrackerOperationRow | null; intentIdentity: string };
  /** The operation that the open stage gave, and the write attempts it recorded. */
  observe: { operation: TrackerOperationRow; attempts: TrackerWriteRow[] };
  /** The operation as the reading before the write settled it, and the approval the caller named. */
  gate: {
    operation: TrackerOperationRow;
    attempts: TrackerWriteRow[];
    target: TrackerTarget;
    approvalId: string | null;
    approval: ApprovalRow | null;
  };
  /** The write attempts recorded, and the caller request that would send one more. */
  write: { attempts: TrackerWriteRow[]; requestId: string };
};

/** What each stage moves on to. `report` ends the event with the operation as recorded. */
export type TrackerStageNext = {
  open:
    | { stage: "plan" }
    | { stage: "resume"; operation: TrackerOperationRow }
    | { stage: "report"; operationId: string };
  observe: "read" | "write";
  gate: "write" | "report";
  write: "write" | "report";
};

/** The approval one uncertain operation needs before another write is sent under it. */
export type AdditionalWriteCheck = {
  action: string;
  targets: string[];
  scope: string;
  requestRevision: string;
};

/**
 * Why another write under one operation is not permitted.
 * It travels beside the step's own outcome, so an unproven effect stays the overall result and
 * the approval problem is recorded rather than reported in its place.
 */
export type ApprovalBlocker =
  | ({ reason: "approval-required" } & AdditionalWriteCheck)
  | { reason: "unknown-approval"; approvalId: string }
  | { reason: "approval-revoked"; approvalId: string }
  | { reason: "approval-mismatch"; approvalId: string; field: string };

/** The refusals of each stage. */
export type TrackerStageRefusal = {
  open: { status: "content-changed"; operationId: string; recorded: string; stated: string };
  observe: never;
  gate: ApprovalBlocker;
  write: never;
};

type Decision<S extends TrackerStage> =
  | { next: TrackerStageNext[S] }
  | { refused: TrackerStageRefusal[S] };

type Rule<S extends TrackerStage> = (facts: TrackerStageFacts[S]) => Decision<S> | null;

type Entry<S extends TrackerStage> = {
  rules: Array<Rule<S>>;
  next: (facts: TrackerStageFacts[S]) => TrackerStageNext[S];
};

/** The action a person approves before another write is sent under one uncertain operation. */
const ADDITIONAL_WRITE = "tracker.additional_write";

/** Outcomes nothing proved, the only ones a person can accept the risk of writing over. */
const UNPROVEN: readonly string[] = [
  "tracker.resolution_outcome_unknown",
  "tracker.completion_outcome_unknown",
  "tracker.map_outcome_unknown",
];

/**
 * The approval check of another write. Its request revision is the number of write attempts
 * already recorded, so one approval covers exactly one additional write and cannot widen to a
 * later one.
 */
function additionalWrite(facts: TrackerStageFacts["gate"]): AdditionalWriteCheck {
  return {
    action: ADDITIONAL_WRITE,
    targets: [
      `${facts.operation.provider}:${facts.target.repository}#${facts.target.issue}`,
      `operation:${facts.operation.id}`,
    ],
    scope: facts.operation.step,
    requestRevision: String(facts.attempts.length),
  };
}

/** The transition table of one record event: the rules of each stage in order, then its next. */
const TRACKER_TABLE: { [S in TrackerStage]: Entry<S> } = {
  open: {
    rules: [
      // A verified step is finished. It is never written again to repair another step.
      ({ operation }) =>
        operation?.state === "verified"
          ? { next: { stage: "report", operationId: operation.id } }
          : null,
      // Changed content is not a retry of an exact-content operation.
      ({ operation, intentIdentity }) =>
        operation !== null && operation.intentIdentity !== intentIdentity
          ? {
              refused: {
                status: "content-changed",
                operationId: operation.id,
                recorded: operation.intentIdentity,
                stated: intentIdentity,
              },
            }
          : null,
    ],
    next: ({ operation }) =>
      operation === null ? { stage: "plan" } : { stage: "resume", operation },
  },
  // A ticket's completion state exists whether or not Operator wrote it, and a step that already
  // sent a write may have landed. A new comment step has nothing to read: its marker cannot
  // exist before its own write.
  observe: {
    rules: [],
    next: ({ operation, attempts }) =>
      operation.step === "completion" || attempts.length > 0 ? "read" : "write",
  },
  // The contract reason decides: only a request the tracker refused is sent again. A settled
  // step stops, an evidence gap stops rather than writing over what it could not see, and an
  // unproven effect stops until a person approves another write.
  gate: {
    rules: [
      // Nothing observed stands in the way, or the tracker refused the request with no effect.
      ({ operation }) => {
        const reason = storedReason(operation.reason);
        return reason === "tracker.pending" || reason === "tracker.write_rejected"
          ? { next: "write" }
          : null;
      },
      // Everything but an unproven earlier effect stops with what it recorded.
      ({ operation, attempts }) =>
        UNPROVEN.includes(operation.reason) && sentWrites(attempts).length > 0
          ? null
          : { next: "report" },
      // A named approval this crew does not hold is a different refusal from naming none.
      ({ approvalId, approval }) =>
        approvalId !== null && approval === null
          ? { refused: { reason: "unknown-approval", approvalId } }
          : null,
      (facts) =>
        facts.approval === null
          ? { refused: { reason: "approval-required", ...additionalWrite(facts) } }
          : null,
      (facts) => {
        const { approval } = facts;
        if (approval === null) {
          return null;
        }
        const coverage = approvalCovers(approval, additionalWrite(facts));
        if (coverage.status === "mismatch") {
          return {
            refused: {
              reason: "approval-mismatch",
              approvalId: approval.id,
              field: coverage.field,
            },
          };
        }
        return coverage.status === "revoked"
          ? { refused: { reason: "approval-revoked", approvalId: approval.id } }
          : null;
      },
    ],
    next: () => "write",
  },
  write: {
    rules: [
      // A replay of one caller request returns what that request recorded. It never sends again.
      ({ attempts, requestId }) =>
        attempts.some((one) => one.requestId === requestId && one.state !== "intended")
          ? { next: "report" }
          : null,
    ],
    next: () => "write",
  },
};

export const TrackerStep = {
  /**
   * Reads the state of one step and what may settle it, as the one rule both the step report
   * and the crew next actions read. A step with no target applies to nothing and offers nothing.
   */
  read(request: { applicable: boolean; operation: TrackerOperationRow | null }): {
    state: TrackerStepState;
    actions: TrackerStepAction[];
  } {
    const state =
      request.operation === null
        ? "unrecorded"
        : readStoredValue("tracker step state", recordedState, request.operation.state);
    return { state, actions: request.applicable ? ACTIONS[state] : [] };
  },

  /**
   * Decides one stage of a record event. It is pure: it reads only the facts the caller
   * gathered, and it returns the first outcome of a rule in the order of the table, or the next
   * stage.
   */
  decide<S extends TrackerStage>(stage: S, facts: TrackerStageFacts[S]): Decision<S> {
    const entry: Entry<S> = TRACKER_TABLE[stage];
    for (const rule of entry.rules) {
      const decided = rule(facts);
      if (decided !== null) {
        return decided;
      }
    }
    return { next: entry.next(facts) };
  },
};
