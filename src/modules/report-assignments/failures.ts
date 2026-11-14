import { isCodedError } from "../../lib/coded-error.ts";
import { z } from "zod";

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
export function qualify<T>(cause: Error, defect: (cause: Error) => T) {
  if (cause instanceof SyntaxError || cause instanceof z.ZodError)
    return {
      reason: "invalid_report_input",
      detail: `${cause.message} Nothing changed.`,
      next: {
        decider: "super-agent" as const,
        question: "What corrected report input should be supplied in --file?",
      },
      state: { inputValid: false },
    };
  if (isCodedError(cause) && ioCodes.includes(cause.code))
    return {
      reason: "report_io_failed",
      detail: String(cause),
      next: {
        decider: "super-agent" as const,
        question: "How should the report IO failure be corrected before retrying?",
      },
      state: { code: cause.code },
    };
  return defect(cause);
}
