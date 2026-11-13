import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
// Bun has no temporary-directory, folder, symlink, listing, mode, or recursive removal API.
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { createBackup, pruneBackups, verifiedBackups } from "./backups.ts";
import { historySchema, migrationsFolder, transaction } from "./database.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Environment } from "../environment/main.ts";

// Root ignores file modes, so a test of a denied access cannot run as root.
const asRoot = process.getuid?.() === 0;

const root = await mkdtemp(path.join(tmpdir(), "operator-backups-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
const receiptFields = z.record(z.string(), z.unknown());
async function readReceipt(file: string) {
  return receiptFields.parse(await Bun.file(file).json());
}
function paths(name: string) {
  return OperatorHome.resolve(
    Environment.parse({
      HOME: root,
      XDG_STATE_HOME: `${root}/${name}`,
      XDG_CONFIG_HOME: `${root}/config`,
      NODE_ENV: "test",
    }),
  );
}

test("a snapshot must match the locked history before it becomes a verified backup", async () => {
  using db = new Database(":memory:");
  migrate(drizzle(db), { migrationsFolder });
  const history = historySchema.parse(
    db.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id").all(),
  );
  expect(
    transaction(db, true, () =>
      createBackup(db, paths("mismatch"), [{ hash: "different", created_at: 1 }]),
    ),
  ).toMatchObject({
    tag: "Err",
    error: {
      reason: "state_backup_failed",
      detail:
        "The migration snapshot failed integrity or history verification. No migration or handler ran.",
    },
  });
  expect(verifiedBackups(paths("mismatch"))).toMatchObject({ tag: "Ok", value: [] });
  const target = paths("matching");
  const copy = transaction(db, true, () => createBackup(db, target, history));
  const verified = verifiedBackups(target).getOrNull() ?? [];
  expect(verified).toHaveLength(1);
  const identity = verified[0]?.identity ?? "";
  // A file-safe identity starts with its creation time.
  expect(identity).toMatch(/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z-[0-9a-f-]{36}$/);
  const files = OperatorHome.migrationBackup(target, identity);
  expect(copy).toMatchObject({ tag: "Ok", value: files.database });
  expect((await stat(target.backups)).mode.toString(8)).toEndWith("700");
  expect((await stat(files.directory)).mode.toString(8)).toEndWith("700");
  expect((await stat(files.database)).mode.toString(8)).toEndWith("600");
  expect((await stat(files.receipt)).mode.toString(8)).toEndWith("600");
  expect(await Bun.file(files.receipt).json()).toEqual({
    identity,
    verifiedAt: verified[0]?.verifiedAt,
    hash: new Bun.CryptoHasher("sha256")
      .update(await Bun.file(files.database).bytes())
      .digest("hex"),
    history,
  });
});

test("verification rejects changed receipt history, content hashes, and corrupt copies without deleting evidence", async () => {
  using db = new Database(":memory:");
  migrate(drizzle(db), { migrationsFolder });
  const history = historySchema.parse(
    db.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id").all(),
  );
  const target = paths("tamper");
  for (let index = 0; index < 4; index++)
    expect(transaction(db, true, () => createBackup(db, target, history)).tag).toBe("Ok");
  const copies = verifiedBackups(target).getOrNull();
  expect(copies).toHaveLength(4);
  if (!copies) return;
  const first = copies[0];
  expect(first).toBeDefined();
  if (!first) return;
  const receipt = OperatorHome.migrationBackup(target, first.identity).receipt;
  const before = await Bun.file(receipt).text();
  await Bun.write(receipt, before.replace(history[0]?.hash ?? "missing", "foreign"));
  expect(verifiedBackups(target).getOrNull()).toHaveLength(3);
  expect(pruneBackups(target).tag).toBe("Ok");
  expect(await Bun.file(first.database).exists()).toBe(true);
  await Bun.write(receipt, before);
  expect(verifiedBackups(target).getOrNull()).toHaveLength(4);
  expect(pruneBackups(target).tag).toBe("Ok");
  expect(verifiedBackups(target).getOrNull()).toHaveLength(3);
  await Bun.write(first.database, "corrupt");
  expect(verifiedBackups(target).getOrNull()).toHaveLength(2);
});

test("discovery skips unreadable receipts and foreign identities, and newest backups come first", async () => {
  using db = new Database(":memory:");
  migrate(drizzle(db), { migrationsFolder });
  const history = historySchema.parse(
    db.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id").all(),
  );
  const target = paths("discovery");
  expect(verifiedBackups(target)).toMatchObject({ tag: "Ok", value: [] });
  for (let index = 0; index < 5; index++)
    expect(transaction(db, true, () => createBackup(db, target, history)).tag).toBe("Ok");
  const copies = verifiedBackups(target).getOrNull() ?? [];
  const identities = copies.map((copy) => copy.identity);
  // Identities start with their creation time, so the newest comes first. Backups made in the
  // same millisecond have no defined order, so only the time part is compared.
  const times = identities.map((identity) => identity.slice(0, "2026-01-01T00-00-00.000Z".length));
  expect(times).toEqual(times.toSorted().toReversed());
  expect(copies.map((copy) => copy.database)).toEqual(
    identities.map((identity) => `${target.backups}/${identity}/operator.sqlite`),
  );
  const [, second, third, fourth, fifth] = identities;
  function receipt(identity = "") {
    return OperatorHome.migrationBackup(target, identity).receipt;
  }
  await Bun.write(receipt(second), "{not json");
  const foreign = await readReceipt(receipt(third));
  await Bun.write(receipt(third), JSON.stringify({ ...foreign, identity: "other" }));
  await Bun.write(receipt(fourth), JSON.stringify({ ...foreign, extra: true }));
  const fifthReceipt = await readReceipt(receipt(fifth));
  {
    using copy = new Database(`${target.backups}/${fifth}/operator.sqlite`);
    copy.exec("DROP TABLE __drizzle_migrations");
  }
  const hash = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(`${target.backups}/${fifth}/operator.sqlite`).bytes())
    .digest("hex");
  await Bun.write(receipt(fifth), JSON.stringify({ ...fifthReceipt, hash }));
  expect(verifiedBackups(target)).toMatchObject({ tag: "Ok", value: [copies[0]] });
});

test("newer verification times come first, equal times order by identity, and an unreadable backup folder is an input failure", async () => {
  using db = new Database(":memory:");
  migrate(drizzle(db), { migrationsFolder });
  const history = historySchema.parse(
    db.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id").all(),
  );
  const target = paths("ties");
  for (let index = 0; index < 3; index++)
    expect(transaction(db, true, () => createBackup(db, target, history)).tag).toBe("Ok");
  const identities = (verifiedBackups(target).getOrNull() ?? []).map((copy) => copy.identity);
  for (const identity of identities) {
    const file = OperatorHome.migrationBackup(target, identity).receipt;
    const receipt = await readReceipt(file);
    await Bun.write(file, JSON.stringify({ ...receipt, verifiedAt: "2026-01-01T00:00:00.000Z" }));
  }
  expect((verifiedBackups(target).getOrNull() ?? []).map((copy) => copy.identity)).toEqual(
    identities.toSorted().toReversed(),
  );
  // The verification time decides first, even against the identity order.
  const ascending = identities.toSorted();
  for (const [index, identity] of ascending.entries()) {
    const file = OperatorHome.migrationBackup(target, identity).receipt;
    const receipt = await readReceipt(file);
    await Bun.write(
      file,
      JSON.stringify({ ...receipt, verifiedAt: `2026-01-0${3 - index}T00:00:00.000Z` }),
    );
  }
  expect((verifiedBackups(target).getOrNull() ?? []).map((copy) => copy.identity)).toEqual(
    ascending,
  );
  const blocked = paths("blocked");
  await Bun.write(blocked.backups, "not a directory", { createPath: true });
  expect(verifiedBackups(blocked)).toMatchObject({
    tag: "Err",
    error: { reason: "state_io_failed" },
  });
  expect(pruneBackups(blocked)).toMatchObject({ tag: "Err", error: { reason: "state_io_failed" } });
});

test("retention removes only the verified backups after the newest three", async () => {
  using db = new Database(":memory:");
  migrate(drizzle(db), { migrationsFolder });
  const history = historySchema.parse(
    db.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id").all(),
  );
  const target = paths("retention");
  for (let index = 0; index < 5; index++)
    expect(transaction(db, true, () => createBackup(db, target, history)).tag).toBe("Ok");
  const identities = (verifiedBackups(target).getOrNull() ?? []).map((copy) => copy.identity);
  // A folder with no receipt is not a verified backup, so retention keeps it as evidence.
  await Bun.write(`${target.backups}/manual/operator.sqlite`, "evidence");
  expect(pruneBackups(target)).toMatchObject({ tag: "Ok", value: undefined });
  expect((await readdir(target.backups)).toSorted()).toEqual(
    [...identities.slice(0, 3), "manual"].toSorted(),
  );
});

test("a damaged copy with a matching hash is not verified, and an unknown read failure is a defect", async () => {
  using db = new Database(":memory:");
  migrate(drizzle(db), { migrationsFolder });
  db.exec("CREATE TABLE filler (value TEXT)");
  for (let index = 0; index < 200; index++)
    db.query("INSERT INTO filler VALUES (?)").run("x".repeat(100));
  const history = historySchema.parse(
    db.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id").all(),
  );
  const target = paths("damaged");
  expect(transaction(db, true, () => createBackup(db, target, history)).tag).toBe("Ok");
  const [copy] = verifiedBackups(target).getOrNull() ?? [];
  const files = OperatorHome.migrationBackup(target, copy?.identity ?? "missing");
  const bytes = await Bun.file(files.database).bytes();
  const last = bytes.length - 4096;
  // Byte 5 of a b-tree page header points at its cell content area.
  bytes[last + 5] = 0xff;
  await Bun.write(files.database, bytes);
  const receipt = await readReceipt(files.receipt);
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  await Bun.write(files.receipt, JSON.stringify({ ...receipt, hash }));
  expect(verifiedBackups(target)).toMatchObject({ tag: "Ok", value: [] });
  // A receipt that links to itself fails with a code no state rule names.
  await mkdir(`${target.backups}/loop`);
  await symlink(`${target.backups}/loop/verified.json`, `${target.backups}/loop/verified.json`);
  expect(verifiedBackups(target).tag).toBe("Defect");
});

test("a copy whose content changed after its receipt is not verified, even with the same history", async () => {
  using db = new Database(":memory:");
  migrate(drizzle(db), { migrationsFolder });
  const history = historySchema.parse(
    db.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id").all(),
  );
  const target = paths("content");
  expect(transaction(db, true, () => createBackup(db, target, history)).tag).toBe("Ok");
  const [copy] = verifiedBackups(target).getOrNull() ?? [];
  {
    using changed = new Database(copy?.database ?? "missing");
    changed.exec("INSERT INTO projects VALUES ('owner/added', '/added', 'now')");
  }
  expect(verifiedBackups(target)).toMatchObject({ tag: "Ok", value: [] });
});

test.skipIf(asRoot)(
  "a backup or a prune that the filesystem refuses is an input failure",
  async () => {
    using db = new Database(":memory:");
    migrate(drizzle(db), { migrationsFolder });
    const history = historySchema.parse(
      db.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id").all(),
    );
    const blocked = paths("refused");
    await Bun.write(blocked.backups, "not a directory", { createPath: true });
    expect(transaction(db, true, () => createBackup(db, blocked, history))).toMatchObject({
      tag: "Err",
      error: { reason: "state_io_failed" },
    });
    const target = paths("locked");
    for (let index = 0; index < 4; index++)
      expect(transaction(db, true, () => createBackup(db, target, history)).tag).toBe("Ok");
    await chmod(target.backups, 0o500);
    try {
      expect(pruneBackups(target)).toMatchObject({
        tag: "Err",
        error: { reason: "state_io_failed" },
      });
    } finally {
      await chmod(target.backups, 0o700);
    }
    expect(await readdir(target.backups)).toHaveLength(4);
  },
);
