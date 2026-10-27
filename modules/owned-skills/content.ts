// Bun has no directory enumeration, lstat, or permission metadata API.
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../../lib/sha256.ts";

export type Contents = Record<string, string>;

export async function info(file: string) {
  try {
    return await lstat(file);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
    // oxlint-disable-next-line unthrown/no-throw -- The module boundary qualifies filesystem failures.
    throw cause;
  }
}

/** A directory entry is part of the identity, including empty and hidden directories. */
export async function contents(directory: string, followLinks: boolean): Promise<Contents | null> {
  const root = await info(directory);
  if (root === null) return null;
  const result: Contents = {};
  Object.setPrototypeOf(result, null);
  async function visit(current: string, relative: string, ancestors: Set<string>) {
    const entry = await info(current);
    if (entry === null) return;
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
      await visit(real, relative, new Set([...ancestors, real]));
    } else if (entry.isDirectory()) {
      result[`${relative}/`] = "directory";
      for (const name of (await readdir(current)).toSorted())
        await visit(path.join(current, name), relative ? `${relative}/${name}` : name, ancestors);
    } else if (entry.isFile()) {
      result[relative] = sha256(await Bun.file(current).bytes());
    } else result[relative] = "special";
  }
  await visit(directory, "", new Set());
  return result;
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
  if (current === null) return released === null ? "matching" : "install";
  if (managed !== null && same(current, managed)) return released === null ? "remove" : "update";
  return "conflict";
}

/**
 * Copy mode refuses links and read-only folders from the destination up to its managed root,
 * even when the linked bytes match. Links above the root belong to the system, such as the
 * macOS `/var` link, but an absent root must not land in a read-only folder such as a Nix store.
 */
export async function writable(root: string, destination: string) {
  for (let current = destination; ; current = path.dirname(current)) {
    const entry = await info(current);
    if (entry !== null && (entry.isSymbolicLink() || !writableMode(entry.mode))) return false;
    if (current === root) {
      if (entry !== null) return true;
      break;
    }
    if (current === path.dirname(current)) return true;
  }
  for (let current = path.dirname(root); ; current = path.dirname(current)) {
    const entry = await stat(current).catch(() => null);
    if (entry !== null) return writableMode(entry.mode);
    if (current === path.dirname(current)) return false;
  }
}

function writableMode(mode: number) {
  return /[2367]/.test(mode.toString(8).slice(-3));
}
