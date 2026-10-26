import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBackup, pruneBackups, verifiedBackups } from "./backups.ts";
import { historySchema, migrationsFolder, transaction } from "./database.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Environment } from "../environment/main.ts";

const root = await mkdtemp(path.join(tmpdir(), "operator-backups-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
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

test("a snapshot must match the locked history before it becomes a verified backup", () => {
  using db = new Database(":memory:");
  migrate(drizzle(db), { migrationsFolder });
  const history = historySchema.parse(
    db.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id").all(),
  );
  expect(
    transaction(db, true, () =>
      createBackup(db, paths("mismatch"), [{ hash: "different", created_at: 1 }]),
    ),
  ).toMatchObject({ tag: "Err", error: { reason: "state_backup_failed" } });
  expect(verifiedBackups(paths("mismatch"))).toMatchObject({ tag: "Ok", value: [] });
  const copy = transaction(db, true, () => createBackup(db, paths("matching"), history));
  expect(copy.tag).toBe("Ok");
  expect(verifiedBackups(paths("matching")).getOrNull()).toHaveLength(1);
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
