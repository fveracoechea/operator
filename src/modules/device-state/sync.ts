// Bun has no file or directory synchronization API.
import { closeSync, fsyncSync, openSync } from "node:fs";

/** Flush one file or directory entry to stable storage, and always release its descriptor. */
export function syncPath(file: string) {
  const fd = openSync(file, "r");
  // Stryker disable next-line BlockStatement: no rule: a running process cannot observe whether bytes reached stable storage before a power loss
  try {
    // Stryker disable next-line CallExpression: no rule: a running process cannot observe whether bytes reached stable storage before a power loss
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
