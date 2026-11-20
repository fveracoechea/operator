import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { migrationsFolder } from "./database.ts";
import type { HandoffContinuation } from "./handoff-continuation.ts";
import { assignments, kindHandoffs, launches, projects, sources } from "./schema.ts";

export const continuation: HandoffContinuation = {
  repository: "owner/repo",
  sourceId: "s1",
  assignment: "build",
  outgoingLaunchId: "implementer",
  startedAt: "2026-11-17T00:00:00.000Z",
  nextKind: "review",
  pane: "worker",
  socket: "/fixture.sock",
};

/** An isolated legacy-kind implementer with a published, fresh continuation hold. */
export function handoffWriteFixture() {
  const client = new Database(":memory:");
  client.exec("PRAGMA foreign_keys = ON");
  const db = drizzle(client);
  migrate(db, { migrationsFolder });
  db.insert(projects)
    .values({ repository: "owner/repo", checkout: "/checkout", registeredAt: "now" })
    .run();
  db.insert(sources)
    .values({
      id: "s1",
      repository: "owner/repo",
      trackerKey: "issue",
      plan: "{}",
      state: "open",
      registeredAt: "now",
      supervisingPane: "supervisor",
      supervisingSession: "ses_supervisor",
    })
    .run();
  db.insert(assignments)
    .values({ sourceId: "s1", key: "build", completion: "pr", state: "pr-open" })
    .run();
  db.insert(launches)
    .values({
      id: "implementer",
      sourceId: "s1",
      assignment: "build",
      attempt: 1,
      name: "builder",
      state: "running",
      resources: "worktree",
      branch: "task/build",
      worktreePath: "/worktree",
      paneId: "worker",
      herdrSocket: "/fixture.sock",
      host: "opencode",
      model: "fixture",
      requestedModel: "fixture",
      reasoningEffort: "medium",
      release: "{}",
      skills: "[]",
      startedAt: "now",
    })
    .run();
  db.insert(kindHandoffs)
    .values({
      sourceId: "s1",
      assignment: "build",
      outgoingLaunchId: "implementer",
      nextKind: "review",
      handoffState: "pending",
      startedAt: continuation.startedAt,
      updatedAt: "before",
      ownerPid: process.pid,
      leaseAt: new Date(Date.now() - 1000).toISOString(),
    })
    .run();
  return client;
}
