// Bun has no lstat, exclusive copy, or directory creation API that refuses links.
import { constants } from "node:fs";
import { copyFile, lstat, mkdir } from "node:fs/promises";
import path from "node:path";

/** Only local environment overrides such as .env.local or .env.development.local qualify. */
export function approvedEnvFile(relative: string) {
  if (relative === "" || path.isAbsolute(relative) || relative.includes("\\")) return false;
  const parts = relative.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  return /^\.env(?:\.[^/]+)?\.local$/.test(parts.at(-1) ?? "");
}

async function entry(file: string) {
  try {
    return await lstat(file);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
    // oxlint-disable-next-line unthrown/no-throw -- The module boundary qualifies filesystem failures.
    throw cause;
  }
}

type Copied = { copied: string[]; preserved: string[]; refused: string[] };

/**
 * Copy approved ignored files from the controlling checkout. Both roots must be real paths.
 * An existing destination is preserved, and a link on either side is refused, never followed.
 */
export async function copyEnvFiles(input: {
  controller: string;
  worktree: string;
  files: string[];
}): Promise<Copied> {
  const result: Copied = { copied: [], preserved: [], refused: [] };
  for (const relative of input.files.toSorted()) {
    if (!approvedEnvFile(relative) || !(await realDirectories(input.controller, relative))) {
      result.refused.push(relative);
      continue;
    }
    const source = await entry(path.join(input.controller, relative));
    if (source === null || !source.isFile()) {
      result.refused.push(relative);
      continue;
    }
    const destination = path.join(input.worktree, relative);
    if (!(await prepareParents(input.worktree, relative))) {
      result.refused.push(relative);
      continue;
    }
    if ((await entry(destination)) !== null) {
      result.preserved.push(relative);
      continue;
    }
    try {
      await copyFile(path.join(input.controller, relative), destination, constants.COPYFILE_EXCL);
      result.copied.push(relative);
    } catch (cause) {
      // Another writer created the destination after the check. Its content stays untouched.
      if (cause instanceof Error && "code" in cause && cause.code === "EEXIST")
        result.preserved.push(relative);
      // oxlint-disable-next-line unthrown/no-throw -- The module boundary qualifies filesystem failures.
      else throw cause;
    }
  }
  return result;
}

async function realDirectories(root: string, relative: string) {
  let current = root;
  for (const part of relative.split("/").slice(0, -1)) {
    current = path.join(current, part);
    const found = await entry(current);
    if (found === null || !found.isDirectory()) return false;
  }
  return true;
}

async function prepareParents(root: string, relative: string) {
  let current = root;
  for (const part of relative.split("/").slice(0, -1)) {
    current = path.join(current, part);
    const found = await entry(current);
    if (found === null) await mkdir(current);
    else if (!found.isDirectory()) return false;
  }
  return true;
}
