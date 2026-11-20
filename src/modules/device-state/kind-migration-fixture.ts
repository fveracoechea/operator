import { Database } from "bun:sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrationsFolder } from "./database.ts";

export function beforeKindsMigration() {
  const client = new Database(":memory:");
  client.exec(
    "PRAGMA foreign_keys = ON; CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)",
  );
  for (const migration of readMigrationFiles({ migrationsFolder }).slice(0, 26)) {
    for (const sql of migration.sql) client.exec(sql);
    client
      .query("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
      .run(migration.hash, migration.folderMillis);
  }
  client.exec(
    "INSERT INTO projects VALUES ('example/one', '/synthetic', 'then'); INSERT INTO sources (id, repository, tracker_key, state, registered_at, plan) VALUES ('source', 'example/one', 'kinds', 'open', 'then', '{}')",
  );
  return client;
}

export function migrateKinds(client: Database) {
  for (const migration of readMigrationFiles({ migrationsFolder }).slice(26)) {
    for (const sql of migration.sql) client.exec(sql);
    client
      .query("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
      .run(migration.hash, migration.folderMillis);
  }
}

export function historicalAssignment(
  client: Database,
  input: {
    key: string;
    state?: string;
    completion?: string;
    kind?: string;
    pr?: boolean;
    review?: string;
    handoff?: string;
    nextKind?: string;
    cleanup?: boolean;
  },
) {
  const { key } = input;
  client
    .query(
      "INSERT INTO assignments (source_id, key, completion, state, kind) VALUES ('source', ?, ?, ?, ?)",
    )
    .run(key, input.completion ?? "pr", input.state ?? "pr-open", input.kind ?? null);
  client
    .query(
      "INSERT INTO launches (id, source_id, assignment, attempt, state, name, resources, branch, host, model, requested_model, reasoning_effort, release, skills, started_at, ended_at) VALUES (?, 'source', ?, 1, 'interrupted', ?, 'worktree', ?, 'opencode', 'fixture', 'fixture', 'medium', '{}', '[]', 'then', 'later')",
    )
    .run(`launch-${key}`, key, key, `task/${key}`);
  if (input.pr !== false)
    client
      .query(
        "INSERT INTO pull_requests (source_id, assignment, repository, number, url, branch, associated_at, progress, wait_state) VALUES ('source', ?, 'example/one', 7, 'https://github.com/example/one/pull/7', ?, 'then', '{\"seen\":[\"comment\"],\"failures\":[],\"eligibleHead\":\"not-readiness\"}', 'idle')",
      )
      .run(key, `task/${key}`);
  if (input.review !== undefined)
    client
      .query(
        "INSERT INTO internal_reviews (source_id, assignment, state, implementer_launch_id, handoff_state, started_at, updated_at) VALUES ('source', ?, ?, ?, 'pending', 'then', 'then')",
      )
      .run(key, input.review, `launch-${key}`);
  if (input.handoff !== undefined)
    client
      .query(
        "INSERT INTO kind_handoffs (source_id, assignment, outgoing_launch_id, next_kind, handoff_state, started_at, updated_at) VALUES ('source', ?, ?, ?, ?, 'then', 'then')",
      )
      .run(key, `launch-${key}`, input.nextKind ?? "review", input.handoff);
  if (input.cleanup)
    client
      .query(
        "INSERT INTO cleanups (source_id, assignment, launch_id, state, updated_at) VALUES ('source', ?, ?, 'failed', 'then')",
      )
      .run(key, `launch-${key}`);
}
