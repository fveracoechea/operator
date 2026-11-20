import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import { workerDevice } from "./worker-fixture.ts";

let device: Awaited<ReturnType<typeof workerDevice>>;
beforeEach(async () => {
  device = await workerDevice();
}, 60000);
afterEach(async () => {
  await rm(device.root, { recursive: true, force: true });
}, 60000);

async function pendingDatabase(blocked: boolean) {
  const file = `${device.root}/state/operator/operator.sqlite`;
  await rm(file);
  using db = new Database(file);
  db.exec(
    "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)",
  );
  const shipped = readMigrationFiles({
    migrationsFolder: Bun.fileURLToPath(new URL("../device-state/migrations/", import.meta.url)),
  });
  for (const migration of shipped.slice(0, 3)) {
    for (const sql of migration.sql) db.exec(sql);
    db.query("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(
      migration.hash,
      migration.folderMillis,
    );
  }
  expect(db.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id").all()).toEqual(
    shipped.slice(0, 3).map(({ hash, folderMillis }) => ({ hash, created_at: folderMillis })),
  );
  expect(shipped.length).toBeGreaterThan(3);
  db.query("INSERT INTO projects VALUES (?, ?, ?)").run(
    "example/one",
    device.main,
    "2026-11-20T00:00:00Z",
  );
  if (blocked)
    db.exec("INSERT INTO project_removals VALUES ('example/held', '2026-11-20T00:00:00Z')");
  return file;
}

async function recorded(file: string) {
  const state = `${device.root}/state/operator`;
  const files: Record<string, string> = {};
  for (const name of await Array.fromAsync(
    new Bun.Glob("**/*").scan({ cwd: state, onlyFiles: true }),
  ))
    files[name] = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(`${state}/${name}`).bytes())
      .digest("hex");
  using db = new Database(file, { readonly: true });
  const worktrees = await device.exec(["git", "worktree", "list", "--porcelain"], device.main);
  return {
    files,
    ledger: db.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id").all(),
    projects: db.query("SELECT * FROM projects").all(),
    sources: db.query("SELECT * FROM sources").all(),
    worktrees: worktrees.stdout,
    effects: await device.herdrCalls(),
  };
}

test.each([false, true])(
  "dual stdin refuses before pending shipped migrations and blocker=%s",
  async (blocked) => {
    const file = await pendingDatabase(blocked);
    await Bun.write(
      `${device.root}/state/operator/backups/keep/operator.sqlite`,
      "Keep this backup unchanged.",
      { createPath: true },
    );
    const beforeBytes = await Bun.file(file).bytes();
    const before = await recorded(file);
    const result = await device.run(
      ["dispatch", "--kind", "answer", "--brief", "-", "--intent-file", "-"],
      { stdin: "Do not read or split this prose." },
    );
    expect({
      code: result.code,
      reason: result.output.reason,
      recorded: await recorded(file),
    }).toEqual({
      code: 2,
      reason: "invalid_source_plan",
      recorded: before,
    });
    expect(result.stderr).toContain("brief and intent cannot both read stdin");
    expect(await Bun.file(file).bytes()).toEqual(beforeBytes);
    const valid = await device.run(["--version"]);
    expect(valid).toMatchObject({
      code: blocked ? 3 : 0,
      output: { reason: blocked ? "state_migration_blocked" : "version_reported" },
    });
    if (blocked) expect(await recorded(file)).toEqual(before);
    else {
      using db = new Database(file, { readonly: true });
      expect(
        db.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id").all(),
      ).toEqual(
        readMigrationFiles({
          migrationsFolder: Bun.fileURLToPath(
            new URL("../device-state/migrations/", import.meta.url),
          ),
        }).map(({ hash, folderMillis }) => ({ hash, created_at: folderMillis })),
      );
      expect(await Bun.file(file).bytes()).not.toEqual(beforeBytes);
      expect(
        Object.keys((await recorded(file)).files).filter((name) => name.endsWith("/verified.json")),
      ).toHaveLength(1);
    }
  },
  60000,
);
