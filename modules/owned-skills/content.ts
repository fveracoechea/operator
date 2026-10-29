// Bun has no directory enumeration, lstat, or permission metadata API.
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isCodedError } from "../../lib/coded-error.ts";
import { sha256 } from "../../lib/sha256.ts";

export type Contents = Record<string, string>;

export async function info(file: string) {
  try {
    return await lstat(file);
  } catch (cause) {
    // Stryker disable next-line ConditionalExpression: equivalent: lstat rejects only with coded errors
    if (isCodedError(cause) && cause.code === "ENOENT") return null;
    // oxlint-disable-next-line unthrown/no-throw -- The module boundary qualifies filesystem failures.
    throw cause;
  }
}

/** A directory entry is part of the identity, including empty and hidden directories. */
export async function contents(directory: string, followLinks = false): Promise<Contents | null> {
  const result: Contents = {};
  Object.setPrototypeOf(result, null);
  async function visit(current: string, relative: string, ancestors: Set<string>) {
    let entry = await info(current);
    if (entry === null) return;
    let followed = ancestors;
    if (entry.isSymbolicLink()) {
      if (!followLinks) {
        result[relative] = "link";
        return;
      }
      const real = await realpath(current);
      if (ancestors.has(real)) {
        result[relative] = "cycle";
        return;
      }
      followed = new Set([...ancestors, real]);
      // Keep the link path, so an undetected cycle ends in ELOOP rather than recursing forever.
      entry = await stat(current);
    }
    if (entry.isDirectory()) {
      result[`${relative}/`] = "directory";
      for (const name of (await readdir(current)).toSorted())
        await visit(path.join(current, name), relative ? `${relative}/${name}` : name, followed);
    } else if (entry.isFile()) {
      result[relative] = sha256(await Bun.file(current).bytes());
    } else result[relative] = "special";
  }
  await visit(directory, "", new Set());
  // An existing directory, file, or link always records at least one entry.
  return Object.keys(result).length === 0 ? null : result;
}

/** A content hash over the entries in UTF-16 code unit order of their paths. */
export function identity(files: Contents) {
  const canonical = JSON.stringify(
    Object.keys(files)
      .toSorted()
      .map((file) => [file, files[file]]),
  );
  return sha256(new TextEncoder().encode(canonical));
}

export function same(left: Contents | null, right: Contents | null) {
  return left === null || right === null
    ? left === right
    : Object.keys(left).length === Object.keys(right).length &&
        Object.entries(left).every(
          ([file, hash]) => Object.hasOwn(right, file) && right[file] === hash,
        );
}

export function verdict(
  current: Contents | null,
  released: Contents | null,
  managed: Contents | null,
): "matching" | "install" | "remove" | "update" | "conflict" {
  if (same(current, released)) return "matching";
  if (current === null) return "install";
  // Stryker disable next-line ConditionalExpression: equivalent: current is not null here, so same(current, null) is false
  if (managed !== null && same(current, managed)) return released === null ? "remove" : "update";
  return "conflict";
}

/**
 * Copy mode refuses links and read-only folders from the destination up to its managed root,
 * even when the linked bytes match. Links above the root belong to the system, such as the
 * macOS `/var` link, but an absent root must not land in a read-only folder such as a Nix store.
 */
export async function writable(root: string, destination: string) {
  for (const current of lineage(destination)) {
    const entry = await info(current);
    if (entry !== null && (entry.isSymbolicLink() || !writableMode(entry.mode))) return false;
    if (current === root) {
      if (entry !== null) return true;
      break;
    }
  }
  for (const current of lineage(path.dirname(root))) {
    const entry = await stat(current).catch(() => null);
    if (entry !== null) return writableMode(entry.mode);
  }
  // Stryker disable next-line BooleanLiteral: equivalent: the file system root always exists, so the walk returns before this line
  return false;
}

/** The path and each ancestor up to the file system root, nearest first. */
function lineage(file: string) {
  const parts = file.split(path.sep);
  return parts.map((_, index) => parts.slice(0, parts.length - index).join(path.sep) || path.sep);
}

function writableMode(mode: number) {
  return /[2367]/.test(mode.toString(8).slice(-3));
}
