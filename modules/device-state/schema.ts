import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  repository: text("repository").primaryKey(),
  checkout: text("checkout").notNull().unique(),
  registeredAt: text("registered_at").notNull(),
});
