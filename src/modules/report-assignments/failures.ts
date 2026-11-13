import { isCodedError } from "../../lib/coded-error.ts";
import { z } from "zod";
import type { ResultContext } from "../../lib/cli-result.ts";

const ioCodes = [
  "ENOENT",
  "EACCES",
  "EPERM",
  "EIO",
  "EROFS",
  "ENOSPC",
  "ENOTDIR",
  "EISDIR",
  "ELOOP",
];

/** Invalid input and file system failures are refusals. Any other error stays a defect. */
export function qualify<T>(cause: Error, defect: (cause: Error) => T, context: ResultContext = {}) {
  if (cause instanceof SyntaxError || cause instanceof z.ZodError)
    return {
      reason: "invalid_report_input",
      detail: `${cause.message} Nothing changed.`,
      ...context,
    };
  if (isCodedError(cause) && ioCodes.includes(cause.code))
    return { reason: "report_io_failed", detail: String(cause) };
  return defect(cause);
}
