import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";
// Bun has no temporary-directory or recursive removal API.
import { chmod, cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { z } from "zod";
import { workflowOutputSchema } from "../../lib/cli-result-fixture.ts";
import { expectWorkflowRefusal } from "./worker-fixture.ts";

let root = "";
const cli = Bun.fileURLToPath(new URL("../../cli.ts", import.meta.url));
const migrationsFolder = Bun.fileURLToPath(new URL("../device-state/migrations/", import.meta.url));
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-compatibility-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function oldDatabase(applied = 1) {
  await mkdir(`${root}/state/operator`, { recursive: true });
  using db = new Database(`${root}/state/operator/operator.sqlite`);
  db.exec(
    "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)",
  );
  const migrations = readMigrationFiles({ migrationsFolder }).slice(0, applied);
  expect(migrations).toHaveLength(applied);
  for (const migration of migrations) {
    for (const sql of migration.sql) db.exec(sql);
    db.query("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(
      migration.hash,
      migration.folderMillis,
    );
  }
  db.query("INSERT INTO projects VALUES (?, ?, ?)").run(
    "example/one",
    root,
    "2026-10-26T00:00:00Z",
  );
}

function start(args: string[], entry = cli, preload?: string) {
  return Bun.spawn([process.execPath, ...(preload ? ["--preload", preload] : []), entry, ...args], {
    cwd: root,
    env: Environment.child({
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      PATH: `${root}/tools:${Environment.read().PATH ?? ""}`,
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function result(child: ReturnType<typeof start>) {
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {
    code,
    output: stdout.startsWith("{") ? (JSON.parse(stdout) as unknown) : stdout,
    stderr,
  };
}

async function run(args: string[], entry = cli) {
  const response = await result(start([...args, "--json"], entry));
  const output = workflowOutputSchema.parse(response.output);
  expectWorkflowRefusal(args, output, response.stderr);
  return { ...response, output };
}

async function backups() {
  try {
    return await Array.fromAsync(
      new Bun.Glob("*/operator.sqlite").scan({ cwd: `${root}/state/operator/backups` }),
    );
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    // oxlint-disable-next-line unthrown/no-throw -- Only an absent fixture directory represents no backups.
    throw cause;
  }
}

async function extendedRelease(sql = "CREATE TABLE later (value TEXT)", blocker?: string) {
  const source = Bun.fileURLToPath(new URL("../../../", import.meta.url));
  const release = `${root}/release`;
  for (const file of ["src", "package.json"])
    await cp(`${source}/${file}`, `${release}/${file}`, { recursive: true });
  await symlink(`${source}/node_modules`, `${release}/node_modules`);
  const folder = `${release}/src/modules/device-state/migrations`;
  const journal = z
    .object({
      entries: z.array(
        z.object({
          idx: z.number(),
          version: z.string(),
          when: z.number(),
          tag: z.string(),
          breakpoints: z.boolean(),
        }),
      ),
      version: z.string(),
      dialect: z.string(),
    })
    .parse(await Bun.file(`${folder}/meta/_journal.json`).json());
  journal.entries.push({
    idx: journal.entries.length,
    version: "6",
    when: 1793100000000,
    tag: "0003_later",
    breakpoints: true,
  });
  await Bun.write(`${folder}/0003_later.sql`, sql);
  await Bun.write(`${folder}/meta/_journal.json`, JSON.stringify(journal));
  const policy = `${release}/src/modules/device-state/migration-policy.ts`;
  await Bun.write(
    policy,
    (await Bun.file(policy).text()).replace(
      "[1793024341510, []],",
      `[1793024341510, []],\n    [1793100000000, ${blocker ? JSON.stringify([blocker]) : "[]"}],`,
    ),
  );
  return `${release}/src/cli.ts`;
}

const historicalHandoffs = [
  { assignment: "done", state: "done", detail: null, lease: null },
  { assignment: "failed", state: "failed", detail: "pane close failed", lease: null },
  { assignment: "pending", state: "pending", detail: null, lease: "2000-01-01T00:00:00.000Z" },
];

/** Only synthetic ended assignments, so no active-assignment guard hides the handoff migration. */
function seedHistoricalHandoffs(stoppedOwner: number | null = null) {
  using db = new Database(`${root}/state/operator/operator.sqlite`);
  db.exec("PRAGMA foreign_keys = ON");
  db.query(
    "INSERT INTO sources (id, repository, tracker_key, state, registered_at, ended_at, plan) VALUES ('history', 'example/one', 'synthetic-history', 'reset', '2026-01-01', '2026-01-02', '{}')",
  ).run();
  for (const row of historicalHandoffs) {
    db.query(
      "INSERT INTO assignments (source_id, key, completion, state) VALUES ('history', ?, 'pr', 'abandoned')",
    ).run(row.assignment);
    db.query(
      "INSERT INTO launches (id, source_id, assignment, attempt, state, name, resources, branch, host, model, requested_model, reasoning_effort, release, skills, started_at, ended_at) VALUES (?, 'history', ?, 1, 'finished', ?, 'worktree', ?, 'opencode', 'fixture', 'fixture', 'high', '{}', '[]', '2026-01-01', '2026-01-02')",
    ).run(
      `launch-${row.assignment}`,
      row.assignment,
      `worker-${row.assignment}`,
      `task/${row.assignment}`,
    );
    db.query(
      "INSERT INTO internal_reviews (source_id, assignment, state, implementer_launch_id, handoff_state, handoff_detail, started_at, updated_at, owner_pid, lease_at, ready_head, comment_id, comment_url, ended_at) VALUES ('history', ?, 'skipped', ?, ?, ?, '2026-01-01', '2026-01-02', ?, ?, 'historical-head', NULL, NULL, '2026-01-02')",
    ).run(
      row.assignment,
      `launch-${row.assignment}`,
      row.state,
      row.detail,
      row.state === "pending" ? stoppedOwner : null,
      row.lease,
    );
  }
}

test("startup backfills populated historical handoffs without changing their history", async () => {
  await oldDatabase(22);
  const stoppedOwner = Bun.spawnSync([process.execPath, "--version"]).pid;
  seedHistoricalHandoffs(stoppedOwner);
  using db = new Database(`${root}/state/operator/operator.sqlite`);
  const history = db.query("SELECT * FROM __drizzle_migrations ORDER BY id").all();
  const reviews = db.query("SELECT * FROM internal_reviews ORDER BY assignment").all();
  const launches = db.query("SELECT * FROM launches ORDER BY id").all();
  expect(await run(["--version"])).toMatchObject({
    code: 0,
    output: { reason: "version_reported" },
  });
  expect(db.query("SELECT * FROM kind_handoffs ORDER BY assignment").all()).toEqual(
    historicalHandoffs.map((row) => ({
      source_id: "history",
      assignment: row.assignment,
      outgoing_launch_id: `launch-${row.assignment}`,
      next_kind: "review",
      handoff_state: row.state,
      handoff_detail: row.detail,
      started_at: "2026-01-01",
      updated_at: "2026-01-02",
      owner_pid: row.state === "pending" ? stoppedOwner : null,
      lease_at: row.lease,
    })),
  );
  expect(db.query("SELECT * FROM internal_reviews ORDER BY assignment").all()).toEqual(reviews);
  expect(db.query("SELECT * FROM launches ORDER BY id").all()).toEqual(launches);
  expect(db.query("SELECT * FROM __drizzle_migrations ORDER BY id LIMIT 22").all()).toEqual(
    history,
  );
  expect(db.query("SELECT * FROM __drizzle_migrations").all()).toHaveLength(23);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(await backups()).toHaveLength(1);
  const beforeRepeat = db.serialize();
  expect(await run(["--version"])).toMatchObject({ code: 0 });
  expect(db.serialize()).toEqual(beforeRepeat);
  expect(await backups()).toHaveLength(1);
});

test.each(["live", "stale", "stopped", "unowned"] as const)(
  "startup respects the count-23 generic handoff lease for a %s owner",
  async (owner) => {
    await oldDatabase(22);
    seedHistoricalHandoffs();
    expect((await run(["--version"])).code).toBe(0);
    const entry = await extendedRelease();
    const child = Bun.spawn([process.execPath, "--version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await child.exited;
    using db = new Database(`${root}/state/operator/operator.sqlite`);
    const pid = owner === "unowned" ? null : owner === "stopped" ? child.pid : process.pid;
    const lease = owner === "stale" ? "2000-01-01T00:00:00.000Z" : new Date().toISOString();
    db.query(
      "UPDATE kind_handoffs SET owner_pid = ?, lease_at = ? WHERE assignment = 'pending'",
    ).run(pid, lease);
    const before = db.serialize();
    const copies = await backups();
    const outcome = await run(["--version"], entry);
    if (owner === "live") {
      expect(outcome).toMatchObject({
        code: 3,
        output: { reason: "state_migration_blocked", state: { idle: false } },
      });
      expect(outcome.stderr).toContain("running kind handoff");
      expect(db.serialize()).toEqual(before);
      expect(await backups()).toEqual(copies);
      expect(db.query("SELECT * FROM __drizzle_migrations").all()).toHaveLength(23);
      db.query("UPDATE kind_handoffs SET owner_pid = NULL, lease_at = NULL").run();
      expect(await run(["--version"], entry)).toMatchObject({ code: 0 });
    } else expect(outcome).toMatchObject({ code: 0 });
    expect(db.query("SELECT * FROM __drizzle_migrations").all()).toHaveLength(24);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'later'").all()).toEqual([
      { name: "later" },
    ]);
  },
  120000,
);

test("startup upgrades matching older history before a state-free handler and verifies its backup", async () => {
  await oldDatabase();
  expect(await run(["--version"])).toMatchObject({
    code: 0,
    output: { reason: "version_reported" },
  });
  using db = new Database(`${root}/state/operator/operator.sqlite`, { readonly: true });
  expect(db.query("SELECT * FROM __drizzle_migrations").all()).toHaveLength(23);
  expect(db.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id").all()).toEqual(
    readMigrationFiles({ migrationsFolder }).map(({ hash, folderMillis }) => ({
      hash,
      created_at: folderMillis,
    })),
  );
  expect(db.query("SELECT * FROM sources").all()).toEqual([]);
  const copies = await backups();
  expect(copies).toHaveLength(1);
  using backup = new Database(`${root}/state/operator/backups/${copies[0]}`, { readonly: true });
  expect(backup.query("PRAGMA integrity_check").values()).toEqual([["ok"]]);
  expect(backup.query("SELECT * FROM __drizzle_migrations").all()).toHaveLength(1);
  expect(backup.query("SELECT repository FROM projects").all()).toEqual([
    { repository: "example/one" },
  ]);
});

test("only explicit registration can pass missing-state startup, while matching history has no migration writes", async () => {
  for (const args of [
    ["--version"],
    ["config", "show"],
    ["config", "plan", "--set", "superAgent.host=opencode"],
    ["config", "apply", "--set", "superAgent.host=opencode"],
    ["install", "--opencode"],
    ["ready"],
    ["next"],
  ])
    expect(await run(args)).toMatchObject({
      code: 3,
      output: { operation: "startup", reason: "state_missing" },
    });
  expect(await result(start(["--help"]))).toMatchObject({ code: 3 });
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).exists()).toBe(false);
  const initialized = Bun.spawn(["git", "init", "-q", root], {
    env: Environment.child(),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await initialized.exited).toBe(0);
  const remote = Bun.spawn(
    ["git", "-C", root, "remote", "add", "origin", "https://github.com/example/one.git"],
    { env: Environment.child(), stdout: "pipe", stderr: "pipe" },
  );
  expect(await remote.exited).toBe(0);
  expect(await run(["project", "show"])).toMatchObject({
    code: 3,
    output: { reason: "state_missing" },
  });
  await oldDatabase();
  expect((await run(["--version"])).code).toBe(0);
  const database = Bun.file(`${root}/state/operator/operator.sqlite`);
  const before = await database.bytes();
  const copies = await backups();
  expect((await run(["config", "show"])).code).toBe(0);
  expect(await database.bytes()).toEqual(before);
  expect((await backups()).toSorted()).toEqual(copies.toSorted());
});

test.each([
  "empty-history",
  "missing-history",
  "unsupported-columns",
  "null-time",
  "conflicting-time",
  "conflicting-hash",
  "newer",
  "corrupt",
])("startup refuses %s before any handler or tool effect", async (mode) => {
  await oldDatabase();
  const database = `${root}/state/operator/operator.sqlite`;
  if (mode === "corrupt") await Bun.write(database, "broken SQLite\n");
  else {
    using db = new Database(database);
    if (mode === "empty-history") db.exec("DELETE FROM __drizzle_migrations");
    if (mode === "missing-history") db.exec("DROP TABLE __drizzle_migrations");
    if (mode === "unsupported-columns")
      db.exec("ALTER TABLE __drizzle_migrations RENAME COLUMN hash TO other");
    if (mode === "null-time") db.exec("UPDATE __drizzle_migrations SET created_at = NULL");
    if (mode === "conflicting-time") db.exec("UPDATE __drizzle_migrations SET created_at = 1");
    if (mode === "conflicting-hash") db.exec("UPDATE __drizzle_migrations SET hash = 'foreign'");
    if (mode === "newer")
      db.exec(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('future', 9999999999999), ('future2', 99999999999999)",
      );
  }
  for (const tool of ["git", "gh", "herdr", "opencode", "claude"]) {
    await Bun.write(
      `${root}/tools/${tool}`,
      `#!${process.execPath}\nawait Bun.write(${JSON.stringify(`${root}/tool-called`)}, "prohibited"); process.exit(99);\n`,
      { createPath: true },
    );
    await chmod(`${root}/tools/${tool}`, 0o755);
  }
  const before = await Bun.file(database).bytes();
  for (const args of [
    ["--version"],
    ["config", "show"],
    ["config", "apply", "--set", "superAgent.host=opencode"],
    ["project", "register"],
    ["source", "register", "--file", "absent"],
    ["next"],
    ["host", "models", "--host", "opencode"],
    ["install", "--opencode"],
    ["ready"],
    ["wake", "check"],
    ["wait"],
  ]) {
    expect(await run(args)).toMatchObject({
      code: 3,
      output: {
        operation: "startup",
        reason: mode === "corrupt" ? "state_corrupt" : "state_incompatible",
      },
    });
  }
  expect(await result(start(["--help"]))).toMatchObject({ code: 3 });
  expect(await Bun.file(database).bytes()).toEqual(before);
  expect(await Bun.file(`${root}/tool-called`).exists()).toBe(false);
  expect(await Bun.file(`${root}/config/operator/config.json`).exists()).toBe(false);
  expect(await Bun.file(`${root}/state/operator/config/apply.json`).exists()).toBe(false);
  expect(await Bun.file(`${root}/config/opencode/skills/super-agent/SKILL.md`).exists()).toBe(
    false,
  );
});

test("a failed backup stops migration and the handler without changing the database", async () => {
  await oldDatabase();
  await Bun.write(`${root}/state/operator/backups`, "blocked backup path");
  const before = await Bun.file(`${root}/state/operator/operator.sqlite`).bytes();
  expect(await run(["install", "--opencode"])).toMatchObject({
    code: 1,
    output: { operation: "startup", reason: "state_io_failed" },
  });
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).bytes()).toEqual(before);
  expect(await Bun.file(`${root}/config/opencode/skills/super-agent/SKILL.md`).exists()).toBe(
    false,
  );
});

test.each(["directory", "link"])(
  "startup refuses an unsupported %s database path without following or replacing it",
  async (mode) => {
    await mkdir(`${root}/state/operator`, { recursive: true });
    const database = `${root}/state/operator/operator.sqlite`;
    if (mode === "directory") await mkdir(database);
    else {
      await Bun.write(`${root}/do-not-open`, "untouched");
      await symlink(`${root}/do-not-open`, database);
    }
    expect(await run(["--version"])).toMatchObject({
      code: 3,
      output: { reason: "state_incompatible" },
    });
    if (mode === "link") expect(await Bun.file(`${root}/do-not-open`).text()).toBe("untouched");
  },
);

test("skipped releases apply each fixed migration in order with one pre-migration snapshot", async () => {
  await oldDatabase();
  const entry = await extendedRelease(
    "CREATE TABLE later AS SELECT repository FROM projects; INSERT INTO later SELECT id FROM sources",
  );
  expect(await run(["--version"], entry)).toMatchObject({ code: 0 });
  using db = new Database(`${root}/state/operator/operator.sqlite`, { readonly: true });
  expect(db.query("SELECT * FROM __drizzle_migrations").all()).toHaveLength(24);
  expect(db.query("SELECT * FROM later").all()).toEqual([{ repository: "example/one" }]);
  expect(await backups()).toHaveLength(1);
});

test("a failed migration rolls back all pending changes and retains its verified backup", async () => {
  await oldDatabase();
  const entry = await extendedRelease(
    "CREATE TABLE later (value TEXT); INSERT INTO absent VALUES ('fail')",
  );
  const before = await Bun.file(`${root}/state/operator/operator.sqlite`).bytes();
  expect(await run(["install", "--opencode"], entry)).toMatchObject({
    code: 1,
    output: { operation: "startup" },
  });
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).bytes()).toEqual(before);
  const copies = await backups();
  expect(copies).toHaveLength(1);
  using backup = new Database(`${root}/state/operator/backups/${copies[0]}`, { readonly: true });
  expect(backup.query("PRAGMA integrity_check").values()).toEqual([["ok"]]);
  expect(backup.query("SELECT * FROM __drizzle_migrations").all()).toHaveLength(1);
  expect(await Bun.file(`${root}/config/opencode/skills/super-agent/SKILL.md`).exists()).toBe(
    false,
  );
});

test.each(["running", "pr-open", "reported"])(
  "a migration runs with a %s assignment and no live process",
  async (state) => {
    await oldDatabase();
    expect((await run(["--version"])).code).toBe(0);
    const entry = await extendedRelease("CREATE TABLE later (value TEXT)");
    using db = new Database(`${root}/state/operator/operator.sqlite`);
    const history = db.query("SELECT * FROM __drizzle_migrations").all();
    db.exec(
      "INSERT INTO sources VALUES ('other', 'example/one', 'tracker:2', 'open', '2026-10-26', NULL, '{}', NULL, NULL)",
    );
    db.query(
      "INSERT INTO assignments (source_id, key, completion, state) VALUES ('other', 'worker', 'pr', ?)",
    ).run(state);
    expect(await run(["--version"], entry)).toMatchObject({ code: 0 });
    expect(db.query("SELECT state FROM assignments").all()).toEqual([{ state }]);
    const migrated = db.query("SELECT * FROM __drizzle_migrations").all();
    expect(migrated.slice(0, history.length)).toEqual(history);
    expect(migrated).toHaveLength(history.length + 1);
    expect(db.query("SELECT * FROM later").all()).toEqual([]);
  },
);

test("migration-specific held records stop startup but assignment state does not", async () => {
  await oldDatabase();
  expect((await run(["--version"])).code).toBe(0);
  const entry = await extendedRelease(
    "CREATE TABLE later (value TEXT)",
    "SELECT 1 FROM sources WHERE state = 'open' LIMIT 1",
  );
  using db = new Database(`${root}/state/operator/operator.sqlite`);
  db.exec(
    "INSERT INTO projects VALUES ('example/two', '/isolated/other', '2026-10-26'); INSERT INTO sources VALUES ('other', 'example/two', 'tracker:2', 'open', '2026-10-26', NULL, '{}', NULL, NULL); INSERT INTO assignments (source_id, key, completion, state) VALUES ('other', 'worker', 'pr', 'running')",
  );
  const copies = await backups();
  for (const state of ["running", "pr-open", "reported"]) {
    db.query("UPDATE assignments SET state = ?").run(state);
    const refusal = await run(["--version"], entry);
    expect(refusal).toMatchObject({
      code: 3,
      output: { reason: "state_migration_blocked" },
    });
    expect(refusal.stderr).toContain("migration-specific held record");
  }
  db.exec("UPDATE assignments SET state = 'ready'");
  expect(await run(["--version"], entry)).toMatchObject({
    code: 3,
    output: { reason: "state_migration_blocked" },
  });
  expect((await backups()).toSorted()).toEqual(copies.toSorted());
  expect(db.query("SELECT * FROM __drizzle_migrations").all()).toHaveLength(23);
  db.exec("UPDATE sources SET state = 'finished'");
  expect((await run(["--version"], entry)).code).toBe(0);
  expect(db.query("SELECT * FROM __drizzle_migrations").all()).toHaveLength(24);
});

test("retention keeps three verified backups only after success and corruption names the latest valid copy", async () => {
  await oldDatabase();
  const original = await Bun.file(`${root}/state/operator/operator.sqlite`).bytes();
  for (let index = 0; index < 4; index++) {
    if (index) await Bun.write(`${root}/state/operator/operator.sqlite`, original);
    expect((await run(["--version"])).code).toBe(0);
  }
  const copies = (await backups()).toSorted();
  expect(copies).toHaveLength(3);
  const last = copies.at(-1);
  expect(last).toBeDefined();
  await Bun.write(`${root}/state/operator/operator.sqlite`, "corrupt");
  const refusal = await run(["--version"]);
  expect(refusal).toMatchObject({ code: 3, output: { reason: "state_corrupt" } });
  expect(refusal.stderr).toContain(last ?? "missing backup");
  await Bun.write(`${root}/state/operator/backups/${last}`, "corrupt backup");
  const fallback = await run(["--version"]);
  expect(fallback.stderr).toContain(copies.at(-2) ?? "missing prior backup");
  expect((await backups()).toSorted()).toEqual(copies.toSorted());
});

test("an unexpected backup discovery defect stays a startup defect rather than a missing-backup claim", async () => {
  await oldDatabase();
  expect((await run(["--version"])).code).toBe(0);
  await Bun.write(`${root}/state/operator/operator.sqlite`, "corrupt");
  const preload = `${root}/backup-defect.ts`;
  await Bun.write(
    preload,
    `import { Database } from "bun:sqlite";
const query = Database.prototype.query;
Database.prototype.query = function(sql, ...args) {
  if (sql === "PRAGMA integrity_check") throw new TypeError("deliberate backup discovery defect");
  return query.call(this, sql, ...args);
};`,
  );
  const refusal = await result(start(["--version", "--json"], cli, preload));
  expect(refusal).toMatchObject({
    code: 1,
    output: { operation: "startup", reason: "startup_defect" },
  });
  expect(refusal.stderr).toContain("deliberate backup discovery defect");
  expect(refusal.stderr).not.toContain("No verified migration backup");
});

test("simultaneous public starts recheck history and create one backup", async () => {
  await oldDatabase();
  await mkdir(`${root}/arrivals`);
  const preload = `${root}/simultaneous.ts`;
  await Bun.write(
    preload,
    `import { Database } from "bun:sqlite";
import { writeFileSync, readdirSync } from "node:fs";
const exec = Database.prototype.exec;
Database.prototype.exec = function(sql, ...args) {
  if (sql === "BEGIN IMMEDIATE") writeFileSync(${JSON.stringify(`${root}/arrivals`)} + "/" + process.pid, "arrived");
  return exec.call(this, sql, ...args);
};
const serialize = Database.prototype.serialize;
Database.prototype.serialize = function(...args) {
  const until = Date.now() + 10000;
  while (readdirSync(${JSON.stringify(`${root}/arrivals`)}).length < 6 && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  return serialize.apply(this, args);
};`,
  );
  const results = await Promise.all(
    Array.from({ length: 6 }, () => result(start(["--version", "--json"], cli, preload))),
  );
  expect(results.map(({ code, stderr }) => ({ code, stderr }))).toEqual(
    Array.from({ length: 6 }, () => ({ code: 0, stderr: "" })),
  );
  expect(await backups()).toHaveLength(1);
  using db = new Database(`${root}/state/operator/operator.sqlite`, { readonly: true });
  expect(db.query("SELECT * FROM __drizzle_migrations").all()).toHaveLength(23);
});

test("a pending migration has a definite writer timeout and never runs its handler", async () => {
  await oldDatabase();
  using writer = new Database(`${root}/state/operator/operator.sqlite`);
  writer.exec("BEGIN IMMEDIATE");
  try {
    expect(await run(["install", "--opencode"])).toMatchObject({
      code: 1,
      output: { operation: "startup", reason: "state_busy" },
    });
    expect(writer.query("SELECT * FROM __drizzle_migrations").all()).toHaveLength(1);
    expect(await Bun.file(`${root}/config/opencode/skills/super-agent/SKILL.md`).exists()).toBe(
      false,
    );
    expect(await backups()).toEqual([]);
  } finally {
    writer.exec("ROLLBACK");
  }
  expect((await run(["--version"])).code).toBe(0);
}, 15000);

test.each(["delete", "wal"])(
  "the protected %s snapshot blocks a process writer until migration completes",
  async (journal) => {
    await oldDatabase();
    {
      using db = new Database(`${root}/state/operator/operator.sqlite`);
      db.exec(`PRAGMA journal_mode = ${journal}`);
    }
    const preload = `${root}/hold.ts`;
    await Bun.write(
      preload,
      `import { Database } from "bun:sqlite";
import { writeFileSync, existsSync } from "node:fs";
const original = Database.prototype.serialize;
Database.prototype.serialize = function(...args) {
  const snapshot = original.apply(this, args);
  writeFileSync(${JSON.stringify(`${root}/snapshot-held`)}, "held");
  const until = Date.now() + 10000;
  while (!existsSync(${JSON.stringify(`${root}/release`)}) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  return snapshot;
};`,
    );
    const migrating = start(["--version", "--json"], cli, preload);
    try {
      for (
        let attempt = 0;
        attempt < 500 && !(await Bun.file(`${root}/snapshot-held`).exists());
        attempt++
      )
        await Bun.sleep(10);
      expect(await Bun.file(`${root}/snapshot-held`).exists()).toBe(true);
      const writer = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { Database } from "bun:sqlite"; import { writeFileSync } from "node:fs"; using db = new Database(${JSON.stringify(`${root}/state/operator/operator.sqlite`)}); db.exec("PRAGMA busy_timeout = 20"); db.exec("BEGIN IMMEDIATE"); writeFileSync(${JSON.stringify(`${root}/writer-admitted`)}, "admitted"); db.exec("UPDATE projects SET registered_at = 'prohibited'"); db.exec("COMMIT");`,
        ],
        { env: Environment.child(), stdout: "pipe", stderr: "pipe" },
      );
      expect(await writer.exited).not.toBe(0);
      expect(await new Response(writer.stderr).text()).toContain("database is locked");
      expect(await Bun.file(`${root}/writer-admitted`).exists()).toBe(false);
    } finally {
      await Bun.write(`${root}/release`, "continue");
    }
    expect(await result(migrating)).toMatchObject({
      code: 0,
      output: { reason: "version_reported" },
    });
    const copies = await backups();
    expect(copies).toHaveLength(1);
    using backup = new Database(`${root}/state/operator/backups/${copies[0]}`, { readonly: true });
    expect(backup.query("SELECT registered_at FROM projects").values()).toEqual([
      ["2026-10-26T00:00:00Z"],
    ]);
  },
);
