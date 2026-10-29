import { isCodedError } from "../../lib/coded-error.ts";
// Bun has no lstat, exclusive copy, or directory creation API that refuses links.
import { constants, lstatSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

/** Only local environment overrides such as .env.local or .env.development.local qualify. */
export function approvedEnvFile(relative: string) {
  // An empty or absolute path has an empty part, so the part check refuses it.
  if (relative.includes("\\")) return false;
  const parts = relative.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  return /^\.env(?:\.[^/]+)?\.local$/.test(path.basename(relative));
}

/** The entry itself, never a link target, or null when nothing exists at the path. */
async function entry(file: string) {
  return lstatSync(file, { throwIfNoEntry: false }) ?? null;
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
    try {
      await copyFile(path.join(input.controller, relative), destination, constants.COPYFILE_EXCL);
      result.copied.push(relative);
    } catch (cause) {
      // The exclusive copy refuses every existing destination, so its content stays untouched.
      if (isCodedError(cause) && cause.code === "EEXIST") result.preserved.push(relative);
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
