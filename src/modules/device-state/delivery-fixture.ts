import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { migrationsFolder } from "./database.ts";
import { insertRow } from "./state-fixture.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";

export const deliveryInput = { launchId: "l", head: "h", selected: false, session: null };

export const deliveryReadiness = JSON.stringify({
  head: "h",
  at: "then",
  note: null,
  dispositions: [],
});

export function deliveryFixture() {
  const db = new Database(":memory:");
  migrate(drizzle(db), { migrationsFolder });
  insertRow(db, "projects", { repository: "o/r", checkout: "/repo" });
  insertRow(db, "sources", {
    id: "s",
    repository: "o/r",
    state: "open",
    supervising_session: "supervisor",
  });
  insertRow(db, "assignments", { source_id: "s", key: "a", completion: "pr", state: "pr-open" });
  insertRow(db, "launches", {
    id: "l",
    source_id: "s",
    assignment: "a",
    attempt: 1,
    branch: "task/a",
    state: "running",
    kind: JSON.stringify(WorkerKinds.resolve("pr-feedback")),
  });
  insertRow(db, "pull_requests", {
    source_id: "s",
    assignment: "a",
    repository: "o/r",
    number: 7,
    branch: "task/a",
    readiness: deliveryReadiness,
  });
  return db;
}
