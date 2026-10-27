import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const projects = sqliteTable("projects", {
  repository: text("repository").primaryKey(),
  checkout: text("checkout").notNull().unique(),
  registeredAt: text("registered_at").notNull(),
});

export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    repository: text("repository")
      .notNull()
      .references(() => projects.repository),
    trackerKey: text("tracker_key").notNull(),
    state: text("state").notNull(),
    registeredAt: text("registered_at").notNull(),
    endedAt: text("ended_at"),
    plan: text("plan").notNull(),
  },
  (table) => [
    uniqueIndex("one_open_parent")
      .on(table.repository, table.trackerKey)
      .where(sql`${table.state} = 'open'`),
  ],
);

export const assignments = sqliteTable(
  "assignments",
  {
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    key: text("key").notNull(),
    completion: text("completion").notNull(),
    state: text("state").notNull(),
  },
  (table) => [primaryKey({ columns: [table.sourceId, table.key] })],
);

// This obligation must outlive the project and all of its source records.
export const projectRemovals = sqliteTable("project_removals", {
  repository: text("repository").primaryKey(),
  removedAt: text("removed_at").notNull(),
});

// Each start keeps its own snapshot, so a replacement never changes a running launch.
export const launches = sqliteTable(
  "launches",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull(),
    assignment: text("assignment").notNull(),
    attempt: integer("attempt").notNull(),
    state: text("state").notNull(),
    name: text("name").notNull().unique(),
    resources: text("resources").notNull(),
    branch: text("branch"),
    host: text("host").notNull(),
    model: text("model").notNull(),
    requestedModel: text("requested_model").notNull(),
    reasoningEffort: text("reasoning_effort").notNull(),
    profile: text("profile"),
    release: text("release").notNull(),
    skills: text("skills").notNull(),
    herdrSocket: text("herdr_socket"),
    workspaceId: text("workspace_id"),
    tabId: text("tab_id"),
    paneId: text("pane_id"),
    worktreePath: text("worktree_path"),
    worktreeWorkspaceId: text("worktree_workspace_id"),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    failureReason: text("failure_reason"),
    failureDetail: text("failure_detail"),
    activity: text("activity"),
    activityAt: text("activity_at"),
    // The dispatching process and its lease. A gone process or a stale lease ends a start.
    ownerPid: integer("owner_pid"),
    leaseAt: text("lease_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.sourceId, table.assignment],
      foreignColumns: [assignments.sourceId, assignments.key],
    }),
    uniqueIndex("one_attempt_number").on(table.sourceId, table.assignment, table.attempt),
  ],
);

// A preparation belongs to a worktree path, including worktrees that Operator did not dispatch.
export const worktreePreparations = sqliteTable("worktree_preparations", {
  path: text("path").primaryKey(),
  repository: text("repository")
    .notNull()
    .references(() => projects.repository, { onDelete: "cascade" }),
  state: text("state").notNull(),
  detail: text("detail").notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  // The preparing hook process and its lease. A gone process or a stale lease ends a preparation.
  ownerPid: integer("owner_pid"),
  leaseAt: text("lease_at"),
});

// One PR for each PR assignment. Its observation progress lets a restarted wait continue.
export const pullRequests = sqliteTable(
  "pull_requests",
  {
    sourceId: text("source_id").notNull(),
    assignment: text("assignment").notNull(),
    repository: text("repository").notNull(),
    number: integer("number").notNull(),
    url: text("url").notNull(),
    branch: text("branch").notNull(),
    associatedAt: text("associated_at").notNull(),
    progress: text("progress").notNull(),
    waitState: text("wait_state").notNull(),
    waitAt: text("wait_at"),
    // The waiting process and its lease. A gone process or a stale lease is a stopped wait.
    waitOwnerPid: integer("wait_owner_pid"),
    waitLeaseAt: text("wait_lease_at"),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.assignment] }),
    foreignKey({
      columns: [table.sourceId, table.assignment],
      foreignColumns: [assignments.sourceId, assignments.key],
    }),
  ],
);

// Each submission keeps its own row, so a replacement reads every earlier report and follow-up.
export const reports = sqliteTable(
  "reports",
  {
    sourceId: text("source_id").notNull(),
    assignment: text("assignment").notNull(),
    number: integer("number").notNull(),
    launchId: text("launch_id")
      .notNull()
      .references(() => launches.id),
    submittedAt: text("submitted_at").notNull(),
    conclusion: text("conclusion").notNull(),
    evidence: text("evidence").notNull(),
    unresolved: text("unresolved").notNull(),
    decisions: text("decisions").notNull(),
    files: text("files").notNull(),
    // Only the supervising SuperAgent decides: accepted or returned with follow-up.
    decision: text("decision"),
    decidedAt: text("decided_at"),
    followUp: text("follow_up"),
    cleanupState: text("cleanup_state"),
    cleanupDetail: text("cleanup_detail"),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.assignment, table.number] }),
    foreignKey({
      columns: [table.sourceId, table.assignment],
      foreignColumns: [assignments.sourceId, assignments.key],
    }),
  ],
);
