// Bun has no lstat, permission check, directory creation, or atomic rename API.
import { access, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { sha256 } from "../../lib/sha256.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { settingsSchema } from "./schema.ts";

type OperatorPaths = ReturnType<typeof OperatorHome.resolve>;

export const receiptSchema = z.strictObject({
  planId: z.string(),
  generation: z.string().nullable(),
  editsIdentity: z.string(),
  previousIdentity: z.string(),
  nextIdentity: z.string(),
  state: z.enum(["pending", "complete", "aborted"]),
});
export type Receipt = z.infer<typeof receiptSchema>;

export function isMissing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function isIoFailure(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    [
      "EACCES",
      "EPERM",
      "EROFS",
      "EIO",
      "ENOENT",
      "EISDIR",
      "ENOTDIR",
      "EEXIST",
      "ENOSPC",
      "SQLITE_BUSY",
      "SQLITE_CANTOPEN",
    ].includes(String(error.code))
  );
}

async function fileInfo(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if (isMissing(error)) return null;
    // oxlint-disable-next-line unthrown/no-throw -- The module boundary qualifies filesystem failures.
    throw error;
  }
}

export async function readConfig(paths: OperatorPaths) {
  const info = await fileInfo(paths.config);
  const exists = info !== null;
  const text = exists ? await Bun.file(paths.config).text() : null;
  const value: unknown = text === null ? {} : JSON.parse(text);
  return {
    path: paths.config,
    exists,
    text,
    identity: sha256(text ?? "absent"),
    config: settingsSchema.parse(value),
  };
}

export async function readReceipt(paths: OperatorPaths) {
  if ((await fileInfo(paths.receipt)) === null) return null;
  const text = await Bun.file(paths.receipt).text();
  try {
    return receiptSchema.parse(JSON.parse(text));
  } catch {
    return "unreadable" as const;
  }
}

export async function writeReceipt(paths: OperatorPaths, receipt: Receipt) {
  const file = await open(paths.receiptTemporary, "wx", 0o600);
  try {
    await Bun.write(Bun.file(file.fd), `${JSON.stringify(receipt, null, 2)}\n`);
    await file.sync();
    await rename(paths.receiptTemporary, paths.receipt);
  } finally {
    await file.close();
    await rm(paths.receiptTemporary, { force: true });
  }
}

/** Check mode bits too, since privileged test runners can pass access on read-only files. */
export async function externallyManaged(paths: OperatorPaths) {
  let checkedDirectory = false;
  for (let candidate = paths.config; ; candidate = path.dirname(candidate)) {
    const info = await fileInfo(candidate);
    if (info !== null) {
      if (info.isSymbolicLink() && (candidate === paths.config || candidate === paths.configRoot))
        return true;
      if (!checkedDirectory) {
        if (!/[2367]/.test(info.mode.toString(8).slice(-3))) return true;
        try {
          await access(candidate, constants.W_OK);
        } catch {
          return true;
        }
        checkedDirectory = info.isDirectory();
      }
    }
    if (candidate === path.dirname(candidate)) return false;
  }
}

/** SQLite releases the settings writer lock when an interrupted process exits. */
export async function withWriteLock<T>(paths: OperatorPaths, action: () => Promise<T>) {
  await mkdir(paths.configState, { recursive: true });
  const database = new Database(paths.writeLock);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("BEGIN IMMEDIATE");
    return await action();
  } finally {
    if (database.inTransaction) database.exec("ROLLBACK");
    database.close();
  }
}

export async function writeConfig(paths: OperatorPaths, text: string, previousIdentity: string) {
  await mkdir(paths.configRoot, { recursive: true });
  const file = await open(paths.configTemporary, "wx", 0o600);
  try {
    await Bun.write(Bun.file(file.fd), text);
    await file.sync();
    if ((await Bun.file(paths.configTemporary).text()) !== text) return "unconfirmed" as const;
    if ((await readConfig(paths)).identity !== previousIdentity || (await externallyManaged(paths)))
      return "stale" as const;
    await rename(paths.configTemporary, paths.config);
    return (await Bun.file(paths.config).text()) === text
      ? ("verified" as const)
      : ("unconfirmed" as const);
  } finally {
    await file.close();
    await rm(paths.configTemporary, { force: true });
  }
}

/** Editor support must not replace a linked or read-only destination. */
export async function writeEditorSchema(paths: OperatorPaths) {
  const destination = { ...paths, config: paths.schema };
  if (await externallyManaged(destination)) return;
  const text = `${JSON.stringify(z.toJSONSchema(settingsSchema), null, 2)}\n`;
  try {
    if ((await fileInfo(paths.schema)) !== null && (await Bun.file(paths.schema).text()) === text)
      return;
    await Bun.write(paths.schema, text, { createPath: true });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["EACCES", "EPERM", "EROFS"].includes(String(error.code))
    )
      return;
    // oxlint-disable-next-line unthrown/no-throw -- Only a read-only editor destination is optional.
    throw error;
  }
}
