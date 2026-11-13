// Bun has no realpath API.
import { realpath } from "node:fs/promises";

/** The real path of an existing file, or null when the file cannot be resolved. */
export async function realPathOrNull(file: string) {
  return realpath(file).catch(() => null);
}
