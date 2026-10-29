import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary directory, directory creation, permissions, or recursive removal API.
import { access, chmod, mkdir, mkdtemp, rm, stat, symlink, utimes } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import {
  externallyManaged,
  isIoFailure,
  isReadOnlyFailure,
  readConfig,
  readReceipt,
  withWriteLock,
  writeConfig,
  writeEditorSchema,
  writeReceipt,
} from "./storage.ts";

// Root ignores file modes, so a test of a denied access cannot run as root.
const asRoot = process.getuid?.() === 0;

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

/** Temporary files that a write left behind, found by their prefix. */
function leftovers(prefix: string) {
  return Array.fromAsync(
    new Bun.Glob(`${path.basename(prefix)}*`).scan({ cwd: path.dirname(prefix), dot: true }),
  );
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
  expect(await leftovers(home.configTemporaryPrefix)).toEqual([]);
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
  // A file left by a stopped write neither blocks the next write nor is touched by it.
  const stopped = `${home.receiptTemporaryPrefix}stopped`;
  await Bun.write(stopped, "unowned\n");
  await writeReceipt(home, { ...receipt, state: "complete" });
  expect(await readReceipt(home)).toEqual({ ...receipt, state: "complete" });
  expect(await Bun.file(stopped).text()).toBe("unowned\n");
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

function coded(code: string | number) {
  return Object.assign(new Error(String(code)), { code });
}

test.each([
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
])("qualifies the filesystem failure %s as I/O", (code) => {
  expect(isIoFailure(coded(code))).toBe(true);
});

test("does not treat arbitrary defects or other codes as I/O", () => {
  expect(isIoFailure(new TypeError("defect"))).toBe(false);
  expect(isIoFailure(coded(5))).toBe(false);
  expect(isIoFailure(coded("EBADF"))).toBe(false);
});

test("qualifies only refused access, refused operations, and read-only file systems as read-only", () => {
  for (const code of ["EACCES", "EPERM", "EROFS"])
    expect(isReadOnlyFailure(coded(code))).toBe(true);
  for (const error of [coded("EISDIR"), coded(13), new Error("EACCES")])
    expect(isReadOnlyFailure(error)).toBe(false);
});

test("reads the present settings and gives an absent file a fixed identity", async () => {
  const home = paths();
  expect((await readConfig(home)).identity).toBe(
    "5ad38304b535c2987dbd24657c1a11b884984ff600d9f389deb0d4e634fee792",
  );
  const text = '{"superAgent":{"host":"opencode"}}';
  await Bun.write(home.config, text, { createPath: true });
  expect(await readConfig(home)).toMatchObject({
    exists: true,
    text,
    config: { superAgent: { host: "opencode" }, workerAgent: {} },
  });
});

test("does not treat a failure other than a missing file as absent settings", async () => {
  const home = paths();
  await Bun.write(home.configRoot, "not a directory", { createPath: true });
  await expect(readConfig(home)).rejects.toMatchObject({ code: "ENOTDIR" });
});

test("round-trips each receipt state", async () => {
  const home = paths();
  await mkdir(home.configState, { recursive: true });
  for (const state of ["pending", "complete", "aborted"] as const) {
    const receipt = {
      planId: "plan",
      generation: "generation",
      editsIdentity: "edits",
      previousIdentity: "before",
      nextIdentity: "after",
      state,
    };
    await writeReceipt(home, receipt);
    expect(await readReceipt(home)).toEqual(receipt);
  }
});

test("removes its temporary receipt when the receipt cannot replace the destination", async () => {
  const home = paths();
  await mkdir(home.receipt, { recursive: true });
  await expect(
    writeReceipt(home, {
      planId: "plan",
      generation: null,
      editsIdentity: "edits",
      previousIdentity: "before",
      nextIdentity: "after",
      state: "pending",
    }),
  ).rejects.toMatchObject({ code: "EISDIR" });
  expect(await leftovers(home.receiptTemporaryPrefix)).toEqual([]);
});

test("releases the SQLite lock after an action succeeds", async () => {
  const home = paths();
  expect(await withWriteLock(home, () => Promise.resolve("done"))).toBe("done");
  const database = new Database(home.writeLock);
  try {
    database.exec("BEGIN IMMEDIATE");
    expect(database.inTransaction).toBe(true);
  } finally {
    database.close();
  }
});

test("does not replace settings whose bytes do not read back the same", async () => {
  const home = paths();
  const initial = await readConfig(home);
  expect(await writeConfig(home, "\uD800", initial.identity)).toBe("unconfirmed");
  expect(await Bun.file(home.config).exists()).toBe(false);
  expect(await leftovers(home.configTemporaryPrefix)).toEqual([]);
});

test("treats a linked settings file or settings directory as externally managed", async () => {
  const home = paths();
  await mkdir(`${root}/real`, { recursive: true });
  await Bun.write(`${root}/real/config.json`, "{}\n");
  await mkdir(home.configRoot, { recursive: true });
  await symlink(`${root}/real/config.json`, home.config);
  expect(await externallyManaged(home)).toBe(true);
  await rm(home.configRoot, { recursive: true });
  await symlink(`${root}/real`, home.configRoot);
  expect(await externallyManaged(home)).toBe(true);
});

test("does not treat a link above the settings directory as external management", async () => {
  const home = paths();
  const configParent = path.dirname(home.configRoot);
  await mkdir(`${root}/real/operator`, { recursive: true });
  await mkdir(path.dirname(configParent), { recursive: true });
  await symlink(`${root}/real`, configParent);
  expect(await externallyManaged(home)).toBe(false);
});

test("treats a directory that the runner cannot write as externally managed", async () => {
  const home = paths();
  await mkdir(home.configRoot, { recursive: true });
  // The group may write, but the owner may not.
  await chmod(home.configRoot, 0o575);
  try {
    expect(await externallyManaged(home)).toBe(
      await access(home.configRoot, constants.W_OK).then(
        () => false,
        () => true,
      ),
    );
  } finally {
    await chmod(home.configRoot, 0o755);
  }
});

test("lets the file system root decide when no other parent exists", async () => {
  const missing = path.join("/", `operator-missing-${crypto.randomUUID()}`);
  const home = { ...paths(), config: path.join(missing, "config.json"), configRoot: missing };
  expect(await externallyManaged(home)).toBe(
    await access("/", constants.W_OK).then(
      () => false,
      () => true,
    ),
  );
});

test("does not write the editor schema through a link", async () => {
  const home = paths();
  await Bun.write(`${root}/linked.json`, "linked");
  await mkdir(home.configRoot, { recursive: true });
  await symlink(`${root}/linked.json`, home.schema);
  await writeEditorSchema(home);
  expect(await Bun.file(`${root}/linked.json`).text()).toBe("linked");
});

test("replaces a different editor schema and leaves an identical one untouched", async () => {
  const home = paths();
  await Bun.write(home.schema, "{}", { createPath: true });
  await writeEditorSchema(home);
  const text = await Bun.file(home.schema).text();
  expect(text).not.toBe("{}");
  const old = new Date("2001-01-01T00:00:00Z");
  await utimes(home.schema, old, old);
  await writeEditorSchema(home);
  expect((await stat(home.schema)).mtime).toEqual(old);
});

test.skipIf(asRoot)("skips an unreadable editor schema and reports other failures", async () => {
  const home = paths();
  await Bun.write(home.schema, "{}", { createPath: true });
  await chmod(home.schema, 0o200);
  await expect(writeEditorSchema(home)).resolves.toBeUndefined();
  await rm(home.schema);
  await mkdir(home.schema);
  await expect(writeEditorSchema(home)).rejects.toMatchObject({ code: "EISDIR" });
});
