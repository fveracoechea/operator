import { isCodedError } from "../../lib/coded-error.ts";

export type StateFailure = {
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

export function qualifyStateFailure<T>(
  cause: Error,
  defect: (cause: Error) => T,
): StateFailure | T {
  // Stryker disable next-line ConditionalExpression: equivalent: an uncoded cause matches no listed code, so every check below falls through to the defect
  if (!isCodedError(cause)) return defect(cause);
  const { code } = cause;
  if (code === "STATE_UNSUPPORTED") return { reason: "state_incompatible", detail: String(cause) };
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED")
    return {
      reason: "state_busy",
      detail: "The device database stayed busy for 5000 ms. No command write was committed.",
    };
  if (code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB")
    return {
      reason: "state_corrupt",
      detail: `The device database is damaged and was not replaced. ${String(cause)}`,
    };
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
    return { reason: "state_io_failed", detail: String(cause) };
  return defect(cause);
}
