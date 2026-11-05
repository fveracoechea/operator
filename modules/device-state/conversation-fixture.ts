import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { migrationsFolder } from "./database.ts";
import { registerSource } from "./sources.ts";
import { registerProject } from "./projects.ts";
import { reserveLaunch, updateLaunch } from "./launches.ts";

/** A migrated in-memory database with source `s1` and its report assignments `read` and `other`. */
export function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(drizzle(db), { migrationsFolder });
  registerProject(db, { repository: "owner/one", checkout: "/one", registeredAt: "now" });
  registerSource(
    db,
    "/one",
    {
      id: "s1",
      repository: "owner/one",
      trackerKey: "APP-1",
      state: "open",
      registeredAt: "now",
      endedAt: null,
      plan: "{}",
    },
    [
      { sourceId: "s1", key: "read", completion: "report", state: "ready" },
      { sourceId: "s1", key: "other", completion: "report", state: "ready" },
    ],
  );
  return db;
}

/** Record a running launch of the assignment in the pane. */
export function running(db: Database, assignment = "read", paneId = "w1:p1") {
  const id = `l-${assignment}`;
  reserveLaunch(db, "/one", "owner/one", {
    id,
    sourceId: "s1",
    assignment,
    state: "starting",
    name: `report-app-1-${assignment}`,
    resources: "pane",
    branch: null,
    host: "opencode",
    model: "test/model",
    requestedModel: "test/model",
    reasoningEffort: "medium",
    profile: null,
    release: "{}",
    skills: "[]",
    herdrSocket: "/herdr.sock",
    workspaceId: null,
    tabId: null,
    paneId: null,
    worktreePath: null,
    worktreeWorkspaceId: null,
    startedAt: "now",
    endedAt: null,
    failureReason: null,
    failureDetail: null,
    activity: null,
    activityAt: null,
  });
  updateLaunch(db, id, { paneId });
  updateLaunch(db, id, { state: "running" });
}

/** The worker's pane of `read`, and the SuperAgent's selector of the same assignment. */
export const pane = { by: "pane", socket: "/herdr.sock", paneId: "w1:p1" } as const;
export const key = {
  by: "key",
  repository: "owner/one",
  checkout: "/one",
  sourceId: "s1",
  assignment: "read",
} as const;
