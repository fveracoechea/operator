import { isCodedError } from "../../lib/coded-error.ts";
import { z } from "zod";

const ioCodes = ["ENOENT", "EACCES", "EPERM", "EISDIR", "EIO", "ENOTDIR"];

/** An unreadable or invalid plan is a refusal. Any other error stays a defect. */
export function qualify<T>(cause: Error, defect: (cause: Error) => T) {
  if (cause instanceof SyntaxError || cause instanceof z.ZodError)
    return { reason: "invalid_source_plan" as const, detail: cause.message };
  if (isCodedError(cause) && ioCodes.includes(cause.code))
    return { reason: "source_io_failed" as const, detail: String(cause) };
  return defect(cause);
}
