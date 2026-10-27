import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary directory, directory creation, permissions, or recursive removal API.
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import {
  externallyManaged,
  isIoFailure,
  readConfig,
  readReceipt,
  withWriteLock,
  writeConfig,
  writeEditorSchema,
  writeReceipt,
} from "./storage.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-settings-storage-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function paths() {
  return OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
}

test("reads defaults, missing receipts, and invalid receipts without creating files", async () => {
  const home = paths();
  expect(await readConfig(home)).toMatchObject({
    exists: false,
    text: null,
    config: { superAgent: {}, workerAgent: {} },
  });
  expect(await readReceipt(home)).toBeNull();
  expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, dot: true }))).toEqual([]);
  await Bun.write(home.receipt, "broken", { createPath: true });
  expect(await readReceipt(home)).toBe("unreadable");
  expect(await Bun.file(home.receipt).text()).toBe("broken");
});

test("writes and verifies exact bytes while refusing stale settings", async () => {
  const home = paths();
  const initial = await readConfig(home);
  expect(await writeConfig(home, "{}\n", initial.identity)).toBe("verified");
  expect(await writeConfig(home, '{"superAgent":{}}\n', initial.identity)).toBe("stale");
  expect(await Bun.file(home.config).text()).toBe("{}\n");
  expect(await Bun.file(home.configTemporary).exists()).toBe(false);
});

test("preserves dangling settings links and read-only directories", async () => {
  const home = paths();
  await mkdir(home.configRoot, { recursive: true });
  await symlink(`${root}/missing`, home.config);
  expect(await externallyManaged(home)).toBe(true);
  await rm(home.config);
  await chmod(home.configRoot, 0o555);
  try {
    expect(await externallyManaged(home)).toBe(true);
  } finally {
    await chmod(home.configRoot, 0o755);
  }
});

test("atomic receipt writes round-trip and do not replace a pre-existing temporary file", async () => {
  const home = paths();
  await mkdir(home.configState, { recursive: true });
  const receipt = {
    planId: "plan",
    generation: null,
    editsIdentity: "edits",
    previousIdentity: "before",
    nextIdentity: "after",
    state: "pending" as const,
  };
  await writeReceipt(home, receipt);
  expect(await readReceipt(home)).toEqual(receipt);
  await Bun.write(home.receiptTemporary, "unowned\n");
  await expect(writeReceipt(home, { ...receipt, state: "complete" })).rejects.toMatchObject({
    code: "EEXIST",
  });
  expect(await readReceipt(home)).toEqual(receipt);
  expect(await Bun.file(home.receiptTemporary).text()).toBe("unowned\n");
});

test("releases the SQLite lock after an action fails", async () => {
  const home = paths();
  await expect(
    withWriteLock(home, () => Promise.reject(new Error("action failed"))),
  ).rejects.toThrow("action failed");
  const database = new Database(home.writeLock);
  try {
    database.exec("BEGIN IMMEDIATE");
    expect(database.inTransaction).toBe(true);
  } finally {
    if (database.inTransaction) database.exec("ROLLBACK");
    database.close();
  }
});

test("editor schema follows the current settings schema without rewriting identical content", async () => {
  const home = paths();
  await writeEditorSchema(home);
  const text = await Bun.file(home.schema).text();
  expect(JSON.parse(text)).toMatchObject({
    properties: { superAgent: { type: "object" } },
    additionalProperties: false,
  });
  await writeEditorSchema(home);
  expect(await Bun.file(home.schema).text()).toBe(text);
});

test("qualifies known filesystem failures without treating arbitrary defects as I/O", () => {
  expect(isIoFailure(Object.assign(new Error("full"), { code: "ENOSPC" }))).toBe(true);
  expect(isIoFailure(new TypeError("defect"))).toBe(false);
  expect(isIoFailure(Object.assign(new Error("numeric"), { code: 5 }))).toBe(false);
});
