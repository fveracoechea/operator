// Bun has no lstat or recursive directory listing API.
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { fromThrowable } from "unthrown";
import { z } from "zod";

const recordSchema = z.array(z.object({ path: z.string(), hash: z.string() }));

/** The content hash of a regular file. A link, a folder, or a missing path has none. */
async function regularHash(file: string) {
  const info = await lstat(file).catch(() => null);
  if (info === null || !info.isFile()) return null;
  return new Bun.CryptoHasher("sha256").update(await Bun.file(file).bytes()).digest("hex");
}

/**
 * The record of the ignored files that the install wrote: each file listed after it and not
 * before it, with its content hash. A link or a folder is left out, so it stays unknown.
 */
export async function recordInstalled(input: {
  worktree: string;
  before: Set<string>;
  after: string[];
}) {
  const installed: { path: string; hash: string }[] = [];
  for (const file of input.after) {
    if (input.before.has(file)) continue;
    const hash = await regularHash(`${input.worktree}/${file}`);
    if (hash !== null) installed.push({ path: file, hash });
  }
  return JSON.stringify(installed);
}

function parseRecord(text: string) {
  const value = fromThrowable(
    () => JSON.parse(text) as unknown,
    (cause, defect) => (cause instanceof SyntaxError ? "invalid" : defect(cause)),
  )().getOr(undefined);
  return recordSchema.safeParse(value).data;
}

/** Every file in an ignored folder, or null when it holds anything but regular files. */
async function folderFiles(worktree: string, folder: string) {
  const entries = await readdir(path.join(worktree, folder), {
    recursive: true,
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (!entry.isFile()) return null;
    files.push(path.relative(worktree, path.join(entry.parentPath, entry.name)));
  }
  return files;
}

/**
 * The ignored entries that are unchanged install output. A file counts while its content equals
 * the recorded hash, and a folder counts while it holds files and each of them counts.
 * A worktree with no record, such as one prepared before the record existed, has no install output.
 */
export async function installedUnchanged(input: {
  worktree: string;
  record: string | null;
  ignored: string[];
}) {
  const unchanged = new Set<string>();
  const recorded = input.record === null ? undefined : parseRecord(input.record);
  if (recorded === undefined) return unchanged;
  const hashes = new Map(recorded.map((row) => [row.path, row.hash]));
  for (const entry of input.ignored) {
    const files = entry.endsWith("/") ? await folderFiles(input.worktree, entry) : [entry];
    if (files === null || files.length === 0) continue;
    let all = true;
    for (const file of files)
      all &&=
        hashes.has(file) && (await regularHash(`${input.worktree}/${file}`)) === hashes.get(file);
    if (all) unchanged.add(entry);
  }
  return unchanged;
}
