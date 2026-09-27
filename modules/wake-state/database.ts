import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
// Bun has no directory creation API.
import { mkdir } from "node:fs/promises";
import { bindings } from "./schema.ts";

/** The plugin owns a separate database, so crew-state migrations never alter wake bindings. */
export async function openWakeState(dir: string) {
  await mkdir(dir, { recursive: true });
  const sqlite = new Database(`${dir}/bindings.sqlite`, { create: true });
  sqlite.exec("pragma busy_timeout = 10000");
  sqlite.exec(`create table if not exists bindings (
    root text primary key, operator_bin text not null, targets text not null,
    owner text not null, acquired text not null, revision integer not null,
    terminal text not null, session text not null, watchers text not null, state text not null
  ) strict`);
  return drizzle({ client: sqlite, schema: { bindings } });
}
