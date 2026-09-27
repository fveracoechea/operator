import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const bindings = sqliteTable("bindings", {
  root: text("root").primaryKey(),
  operatorBin: text("operator_bin").notNull(),
  targets: text("targets").notNull(),
  owner: text("owner").notNull(),
  acquired: text("acquired").notNull(),
  revision: integer("revision").notNull(),
  terminal: text("terminal").notNull(),
  session: text("session").notNull(),
  watchers: text("watchers").notNull(),
  state: text("state").notNull(),
});

export type Binding = typeof bindings.$inferSelect;
export type NewBinding = typeof bindings.$inferInsert;
