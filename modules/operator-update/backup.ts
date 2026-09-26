// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";

export const BACKUP_ROOT = ".operator/local/backups";

/** The durable records an update must be able to put back exactly as it found them. */
export const BACKED_UP_PATHS = [
  ".operator/local/crew-state.sqlite",
  ".operator/local/crew-state.sqlite-wal",
  ".operator/local/crew-state.sqlite-shm",
  ".operator/local/readiness.json",
  ".operator/local/setup-journal.json",
  ".operator/install/selection.json",
];

export type BackupEntry = { path: string; identity: string };

export type Backup =
  | { status: "verified"; root: string; entries: BackupEntry[] }
  | { status: "unverified"; root: string; entries: BackupEntry[]; failed: string[] };

async function identityOf(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return null;
  }

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(new Uint8Array(await file.arrayBuffer()));
  return hasher.digest("hex");
}

/** The files this project actually holds, of the ones an update would put back. */
export async function backupTargets(projectRoot: string): Promise<string[]> {
  const found: string[] = [];
  for (const path of BACKED_UP_PATHS) {
    if (await Bun.file(`${projectRoot}/${path}`).exists()) {
      found.push(path);
    }
  }

  return found;
}

/**
 * Copies every durable record aside and reads each copy back.
 * The copy is compared by content, so a backup that did not land is a refusal rather than a
 * promise nobody checked.
 */
export async function takeBackup(request: {
  projectRoot: string;
  updateId: string;
}): Promise<Backup> {
  const root = `${BACKUP_ROOT}/${request.updateId}`;
  const absoluteRoot = `${request.projectRoot}/${root}`;
  await rm(absoluteRoot, { force: true, recursive: true });

  const entries: BackupEntry[] = [];
  const failed: string[] = [];

  for (const path of await backupTargets(request.projectRoot)) {
    const source = `${request.projectRoot}/${path}`;
    const copy = `${absoluteRoot}/${path}`;
    const identity = await identityOf(source);
    if (identity === null) {
      continue;
    }

    await Bun.write(copy, Bun.file(source), { createPath: true });
    if ((await identityOf(copy)) === identity) {
      entries.push({ path, identity });
    } else {
      failed.push(path);
    }
  }

  return failed.length === 0
    ? { status: "verified", root, entries }
    : { status: "unverified", root, entries, failed };
}

/** Puts back exactly what the verified backup holds, after a step of the update failed. */
export async function restoreBackup(request: {
  projectRoot: string;
  backup: Backup;
}): Promise<{ status: "restored" | "incomplete"; restored: string[]; failed: string[] }> {
  const restored: string[] = [];
  const failed: string[] = [];

  for (const entry of request.backup.entries) {
    const copy = `${request.projectRoot}/${request.backup.root}/${entry.path}`;
    const target = `${request.projectRoot}/${entry.path}`;
    await Bun.write(target, Bun.file(copy), { createPath: true });
    if ((await identityOf(target)) === entry.identity) {
      restored.push(entry.path);
    } else {
      failed.push(entry.path);
    }
  }

  return { status: failed.length === 0 ? "restored" : "incomplete", restored, failed };
}
