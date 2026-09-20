// Bun has no lstat API.
import { lstat } from "node:fs/promises";

export async function firstSymlink(
  projectRoot: string,
  relativePath: string,
): Promise<string | undefined> {
  let path = projectRoot;
  let relative = "";
  for (const segment of relativePath.split("/")) {
    path = `${path}/${segment}`;
    relative = relative.length === 0 ? segment : `${relative}/${segment}`;
    const stat = await lstat(path).catch((error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      ) {
        return undefined;
      }
      throw error;
    });
    if (!stat) {
      return undefined;
    }
    if (stat.isSymbolicLink()) {
      return relative;
    }
  }
  return undefined;
}
