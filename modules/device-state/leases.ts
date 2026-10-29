import { isCodedError } from "../../lib/coded-error.ts";

// The owner renews its lease while it runs. The stale limit also covers a reused process id.
export const leaseRenewMs = 15000;
const leaseStaleMs = 300000;

/** A held record whose owner process is gone, or whose lease is stale, holds nothing. */
export function ownerGone(row: { ownerPid: number | null; leaseAt: string | null }, now: number) {
  if (row.ownerPid === null || row.leaseAt === null) return true;
  if (Date.parse(row.leaseAt) < now - leaseStaleMs) return true;
  try {
    process.kill(row.ownerPid, 0);
    return false;
  } catch (cause) {
    // EPERM means that the process exists under another user.
    // Stryker disable next-line ConditionalExpression: equivalent: process.kill fails only with a coded error, so the type check only narrows the type
    return isCodedError(cause) && cause.code === "ESRCH";
  }
}
