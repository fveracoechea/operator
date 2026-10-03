import { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
// Bun has no directory creation API.
import { mkdir } from "node:fs/promises";

const bindings = sqliteTable("bindings", {
  root: text("root").primaryKey(),
  operatorBin: text("operator_bin").notNull(),
  targets: text("targets").notNull(),
  owner: text("owner").notNull(),
  acquired: text("acquired").notNull(),
  revision: integer("revision").notNull(),
  terminal: text("terminal").notNull(),
  session: text("session").notNull(),
  watchers: text("watchers").notNull(),
  state: text("state", { enum: ["armed", "submitted", "stale"] }).notNull(),
});

export type Binding = typeof bindings.$inferSelect;

/**
 * The plugin owns a separate database, so crew-state migrations never alter wake bindings.
 * Each write that leaves `armed` is conditional on the row still being armed, so two checks that
 * race on one binding move it once.
 */
export async function openStore(dir: string) {
  await mkdir(dir, { recursive: true });
  const sqlite = new Database(`${dir}/bindings.sqlite`, { create: true });
  sqlite.exec("pragma busy_timeout = 10000");
  sqlite.exec(`create table if not exists bindings (
    root text primary key, operator_bin text not null, targets text not null,
    owner text not null, acquired text not null, revision integer not null,
    terminal text not null, session text not null, watchers text not null, state text not null
  ) strict`);
  const db = drizzle({ client: sqlite, schema: { bindings } });
  const armedRow = (root: string) => and(eq(bindings.root, root), eq(bindings.state, "armed"));

  return {
    armed(root: string): Binding | undefined {
      return db.select().from(bindings).where(armedRow(root)).get();
    },
    /** Arms the binding of one root, and replaces any earlier binding of it. */
    save(values: Binding): void {
      db.insert(bindings)
        .values(values)
        .onConflictDoUpdate({ target: bindings.root, set: values })
        .run();
    },
    markStale(root: string): void {
      db.update(bindings).set({ state: "stale" }).where(armedRow(root)).run();
    },
    /** Moves an armed binding to submitted. Only one caller gets true for one arm. */
    claim(root: string): boolean {
      return (
        db
          .update(bindings)
          .set({ state: "submitted" })
          .where(armedRow(root))
          .returning({ root: bindings.root })
          .get() !== undefined
      );
    },
    close(): void {
      sqlite.close();
    },
  };
}
