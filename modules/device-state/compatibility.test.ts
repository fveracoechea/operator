import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compatibility } from "./compatibility.ts";
import { migrationsFolder } from "./database.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Environment } from "../environment/main.ts";

const shipped = readMigrationFiles({ migrationsFolder });
let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function home() {
  root = await mkdtemp(path.join(tmpdir(), "operator-startup-"));
  return OperatorHome.resolve(
    Environment.parse({
      HOME: root,
      XDG_STATE_HOME: `${root}/state`,
      XDG_CONFIG_HOME: `${root}/config`,
      NODE_ENV: "test",
    }),
  );
}

/** An older release recorded only its first `count` shipped migrations. */
async function olderDatabase(file: string, count: number) {
  await Bun.write(`${path.dirname(file)}/.keep`, "", { createPath: true });
  using db = new Database(file);
  db.exec(
    "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)",
  );
  for (const migration of shipped.slice(0, count)) {
    for (const sql of migration.sql) db.exec(sql);
    db.query("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(
      migration.hash,
      migration.folderMillis,
    );
  }
  db.exec("INSERT INTO projects VALUES ('owner/repo', '/isolated/repo', 'now')");
}

function history(file: string) {
  using db = new Database(file, { readonly: true });
  return db.query("SELECT hash FROM __drizzle_migrations ORDER BY id").values().flat();
}

async function backups(directory: string) {
  return (
    await Array.fromAsync(new Bun.Glob("*/operator.sqlite").scan({ cwd: directory }))
  ).toSorted();
}

test("the compatibility owner never creates missing state and preserves corruption with no backup claim", async () => {
  const paths = await home();
  expect(compatibility(paths)).toMatchObject({
    tag: "Err",
    error: {
      reason: "state_missing",
      detail:
        "The device database is missing. Run operator project register explicitly in the controlling checkout before any other command.",
    },
  });
  expect(compatibility(paths, true).tag).toBe("Ok");
  expect(await Bun.file(paths.database).exists()).toBe(false);
  await Bun.write(paths.database, "corrupt", { createPath: true });
  const result = compatibility(paths);
  expect(result.tag).toBe("Err");
  if (result.tag === "Err") {
    expect(result.error.reason).toBe("state_corrupt");
    expect(result.error.detail).toEndWith(" No verified migration backup is available.");
  }
  expect(await Bun.file(paths.database).text()).toBe("corrupt");
});

test("an older history upgrades once behind a verified backup, and retention keeps three", async () => {
  const paths = await home();
  await olderDatabase(paths.database, 1);
  const original = await Bun.file(paths.database).bytes();
  expect(compatibility(paths)).toMatchObject({ tag: "Ok", value: undefined });
  expect(history(paths.database)).toEqual(shipped.map((migration) => migration.hash));
  {
    // The upgrade ran each pending migration, not only its history record.
    using db = new Database(paths.database, { readonly: true });
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'slack_effects'").all()).toEqual([
      { name: "slack_effects" },
    ]);
  }
  const first = await backups(paths.backups);
  expect(first).toHaveLength(1);
  expect(history(`${paths.backups}/${first[0]}`)).toMatchObject([shipped[0]?.hash]);
  // Matching history writes nothing and takes no backup.
  const upgraded = await Bun.file(paths.database).bytes();
  expect(compatibility(paths)).toMatchObject({ tag: "Ok", value: undefined });
  expect(await Bun.file(paths.database).bytes()).toEqual(upgraded);
  expect(await backups(paths.backups)).toEqual(first);
  for (let index = 0; index < 3; index++) {
    await Bun.write(paths.database, original);
    expect(compatibility(paths).tag).toBe("Ok");
  }
  const kept = await backups(paths.backups);
  expect(kept).toHaveLength(3);
  expect(kept).not.toContain(first[0]);
  await Bun.write(paths.database, "corrupt");
  const corrupt = compatibility(paths);
  expect(corrupt.tag).toBe("Err");
  if (corrupt.tag === "Err") {
    expect(corrupt.error.reason).toBe("state_corrupt");
    expect(corrupt.error.detail).toEndWith(
      ` Last verified backup: ${paths.backups}/${kept.at(-1)}`,
    );
  }
});

test("held records stop the upgrade before any backup or migration", async () => {
  const paths = await home();
  await olderDatabase(paths.database, 3);
  {
    using db = new Database(paths.database);
    db.exec("INSERT INTO project_removals VALUES ('owner/removed', 'now')");
  }
  expect(compatibility(paths)).toMatchObject({
    tag: "Err",
    error: {
      reason: "state_migration_blocked",
      detail: "Finish pending project file cleanup before an upgrade. No handler ran.",
    },
  });
  expect(history(paths.database)).toEqual(shipped.slice(0, 3).map((migration) => migration.hash));
  expect(await Bun.file(paths.backups).exists()).toBe(false);
});

test("a failed backup stops the upgrade and keeps the older history", async () => {
  const paths = await home();
  await olderDatabase(paths.database, 1);
  await Bun.write(paths.backups, "not a directory");
  expect(compatibility(paths)).toMatchObject({ tag: "Err", error: { reason: "state_io_failed" } });
  expect(history(paths.database)).toMatchObject([shipped[0]?.hash]);
  expect(await Bun.file(paths.backups).text()).toBe("not a directory");
});

test("unsupported history is refused without an upgrade or a backup", async () => {
  const paths = await home();
  await olderDatabase(paths.database, 1);
  {
    using db = new Database(paths.database);
    db.exec("UPDATE __drizzle_migrations SET hash = 'foreign'");
  }
  expect(compatibility(paths)).toMatchObject({
    tag: "Err",
    error: { reason: "state_incompatible" },
  });
  expect(history(paths.database)).toEqual(["foreign"]);
  expect(await Bun.file(paths.backups).exists()).toBe(false);
});

test("damage with unreadable backup evidence reports the backup failure", async () => {
  const paths = await home();
  await Bun.write(paths.database, "corrupt", { createPath: true });
  await Bun.write(paths.backups, "not a directory");
  expect(compatibility(paths)).toMatchObject({ tag: "Err", error: { reason: "state_io_failed" } });
  expect(await Bun.file(paths.database).text()).toBe("corrupt");
});

test("matching history needs no writer reservation", async () => {
  const paths = await home();
  await olderDatabase(paths.database, shipped.length);
  using competitor = new Database(paths.database);
  competitor.exec("BEGIN IMMEDIATE");
  // A write would wait for the busy timeout, so a separate process shows whether the check blocks.
  const owner = Bun.fileURLToPath(new URL("./compatibility.ts", import.meta.url));
  const script = `import { compatibility } from ${JSON.stringify(owner)};
console.log(compatibility(${JSON.stringify(paths)}).tag);`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "ignore" });
  const outcome = await Promise.race([
    child.exited.then(() => new Response(child.stdout).text()),
    Bun.sleep(2000).then(() => "blocked"),
  ]);
  child.kill();
  competitor.exec("ROLLBACK");
  expect(outcome.trim()).toBe("Ok");
});
