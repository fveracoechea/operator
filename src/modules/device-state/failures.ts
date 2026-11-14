import { isCodedError } from "../../lib/coded-error.ts";
import type { NextStep, ResultContext } from "../../lib/cli-result.ts";

export type StateFailure = ResultContext & {
  reason:
    | "state_missing"
    | "state_busy"
    | "state_io_failed"
    | "state_incompatible"
    | "state_corrupt"
    | "state_backup_failed"
    | "state_migration_blocked"
    | "controller_mismatch"
    | "controller_identity_mismatch";
  detail: string;
};

const recovery: Record<StateFailure["reason"], NextStep> = {
  state_missing: {
    command: "operator project register",
    why: "Register a project explicitly to initialize device state.",
  },
  state_busy: {
    decider: "super-agent",
    question: "When has the active state operation finished so this command can be retried?",
  },
  state_io_failed: {
    decider: "super-agent",
    question: "How should the device state IO failure be corrected without overwriting state?",
  },
  state_corrupt: {
    decider: "person",
    question: "How should the damaged device state be recovered without overwriting it?",
  },
  state_incompatible: {
    decider: "person",
    question: "Which compatible Operator release should be used for this device state?",
  },
  state_backup_failed: {
    decider: "super-agent",
    question: "How should the backup failure be corrected before the upgrade is retried?",
  },
  state_migration_blocked: {
    decider: "super-agent",
    question: "How should the recorded live operations finish before the upgrade is retried?",
  },
  controller_mismatch: {
    command: "operator project list",
    why: "Find the recorded controlling checkout and run the command there.",
  },
  controller_identity_mismatch: {
    decider: "super-agent",
    question: "How should the controlling checkout's recorded GitHub remote be restored?",
  },
};

/** Only this state owner's closed failure tags select its recovery. Facts come from the guard. */
export function stateFailure(
  reason: StateFailure["reason"],
  detail: string,
  state: NonNullable<ResultContext["state"]>,
): StateFailure {
  return { reason, detail, next: recovery[reason], state };
}

export function qualifyStateFailure<T>(
  cause: Error,
  defect: (cause: Error) => T,
): StateFailure | T {
  // Stryker disable next-line ConditionalExpression: equivalent: an uncoded cause matches no listed code, so every check below falls through to the defect
  if (!isCodedError(cause)) return defect(cause);
  const { code } = cause;
  if (code === "STATE_UNSUPPORTED")
    return stateFailure("state_incompatible", String(cause), { code });
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED")
    return stateFailure(
      "state_busy",
      "The device database stayed busy for 5000 ms. No command write was committed.",
      { code },
    );
  if (code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB")
    return stateFailure(
      "state_corrupt",
      `The device database is damaged and was not replaced. ${String(cause)}`,
      { code },
    );
  if (
    [
      "ENOENT",
      "EEXIST",
      "EACCES",
      "EPERM",
      "EROFS",
      "EIO",
      "ENOSPC",
      "ENOTEMPTY",
      "EBUSY",
      "EISDIR",
      "ENOTDIR",
      "SQLITE_CANTOPEN",
      "SQLITE_READONLY",
      "SQLITE_IOERR",
      "SQLITE_FULL",
    ].includes(code)
  )
    return stateFailure("state_io_failed", String(cause), { code });
  return defect(cause);
}
