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
  repository: text().primaryKey(),
  checkout: text().notNull().unique(),
  registeredAt: text("registered_at").notNull(),
});

export const sources = sqliteTable(
  "sources",
  {
    id: text().primaryKey(),
    repository: text()
      .notNull()
      .references(() => projects.repository),
    trackerKey: text("tracker_key").notNull(),
    state: text().notNull(),
    registeredAt: text("registered_at").notNull(),
    endedAt: text("ended_at"),
    plan: text().notNull(),
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
    key: text().notNull(),
    completion: text().notNull(),
    state: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.sourceId, table.key] })],
);

// This obligation must outlive the project and all of its source records.
export const projectRemovals = sqliteTable("project_removals", {
  repository: text().primaryKey(),
  removedAt: text("removed_at").notNull(),
});

// Each start keeps its own snapshot, so a replacement never changes a running launch.
export const launches = sqliteTable(
  "launches",
  {
    id: text().primaryKey(),
    sourceId: text("source_id").notNull(),
    assignment: text().notNull(),
    attempt: integer().notNull(),
    state: text().notNull(),
    name: text().notNull().unique(),
    resources: text().notNull(),
    branch: text(),
    host: text().notNull(),
    model: text().notNull(),
    requestedModel: text("requested_model").notNull(),
    reasoningEffort: text("reasoning_effort").notNull(),
    profile: text(),
    release: text().notNull(),
    skills: text().notNull(),
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
    activity: text(),
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
  path: text().primaryKey(),
  repository: text()
    .notNull()
    .references(() => projects.repository, { onDelete: "cascade" }),
  state: text().notNull(),
  detail: text().notNull(),
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
    assignment: text().notNull(),
    repository: text().notNull(),
    number: integer().notNull(),
    url: text().notNull(),
    branch: text().notNull(),
    associatedAt: text("associated_at").notNull(),
    progress: text().notNull(),
    waitState: text("wait_state").notNull(),
    waitAt: text("wait_at"),
    // The waiting process and its lease. A gone process or a stale lease is a stopped wait.
    waitOwnerPid: integer("wait_owner_pid"),
    waitLeaseAt: text("wait_lease_at"),
    // The verified merge. Cleanup compares each resource with this head before it disposes it.
    mergedHead: text("merged_head"),
    mergeCommit: text("merge_commit"),
    mergedAt: text("merged_at"),
    // The stack parent and the parent-merge relay progress of a PR stacked on a parent PR.
    relay: text(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.assignment] }),
    foreignKey({
      columns: [table.sourceId, table.assignment],
      foreignColumns: [assignments.sourceId, assignments.key],
    }),
  ],
);

// The ordered disposal after a verified merge. A failure stays recorded until a retry finishes it.
export const cleanups = sqliteTable(
  "cleanups",
  {
    sourceId: text("source_id").notNull(),
    assignment: text().notNull(),
    // The launch whose pane and worktree are disposed.
    launchId: text("launch_id")
      .notNull()
      .references(() => launches.id),
    // The next step to run. Earlier steps are done, and a finished cleanup has no step.
    step: text(),
    state: text().notNull(),
    reason: text(),
    detail: text(),
    updatedAt: text("updated_at").notNull(),
    // The cleaning process and its lease. A gone process or a stale lease is a stopped cleanup.
    ownerPid: integer("owner_pid"),
    leaseAt: text("lease_at"),
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
    assignment: text().notNull(),
    number: integer().notNull(),
    launchId: text("launch_id")
      .notNull()
      .references(() => launches.id),
    submittedAt: text("submitted_at").notNull(),
    conclusion: text().notNull(),
    evidence: text().notNull(),
    unresolved: text().notNull(),
    decisions: text().notNull(),
    files: text().notNull(),
    // Only the supervising SuperAgent decides: accepted or returned with follow-up.
    decision: text(),
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

// A review request is not an assignment. One request per PR is open until it is closed or skipped.
// An approved request stays open, so a renewed request reopens it. The approval releases its reviewer.
export const reviewRequests = sqliteTable(
  "review_requests",
  {
    id: text().primaryKey(),
    repository: text()
      .notNull()
      .references(() => projects.repository, { onDelete: "cascade" }),
    number: integer().notNull(),
    url: text().notNull(),
    // `slack` also covers a manual addition. `assignment` is the optional reviewer of a PR assignment.
    origin: text().notNull(),
    sourceId: text("source_id"),
    assignment: text(),
    state: text().notNull(),
    requestedAt: text("requested_at").notNull(),
    endedAt: text("ended_at"),
    // The reviewer launch. Its branch is local and Operator never pushes it.
    launchState: text("launch_state"),
    launch: text(),
    name: text().unique(),
    branch: text(),
    head: text(),
    herdrSocket: text("herdr_socket"),
    workspaceId: text("workspace_id"),
    tabId: text("tab_id"),
    paneId: text("pane_id"),
    worktreePath: text("worktree_path"),
    worktreeWorkspaceId: text("worktree_workspace_id"),
    failureReason: text("failure_reason"),
    failureDetail: text("failure_detail"),
    // The process that starts the reviewer, posts the review, moves the reviewer, or cleans up.
    ownerPid: integer("owner_pid"),
    leaseAt: text("lease_at"),
    // The trigger of the round in progress, and the head moves since its reviewer got the round.
    trigger: text(),
    headMoves: integer("head_moves").notNull().default(0),
    // While watching: the last author activity, the stale mark, and the reviewer's resolved threads.
    activityAt: text("activity_at"),
    staleAt: text("stale_at"),
    resolvedThreads: text("resolved_threads"),
    // A reviewer move or prompt that a wait or a post decided and has not finished.
    sync: text(),
    // Reviewer cleanup after the request is approved, closed, or skipped.
    cleanupState: text("cleanup_state"),
    cleanupDetail: text("cleanup_detail"),
    // The Slack message that posted the PR. Its thread gets one reply for each posted round.
    slackChannel: text("slack_channel"),
    slackTs: text("slack_ts"),
  },
  (table) => [
    uniqueIndex("one_open_review")
      .on(table.repository, table.number)
      .where(sql`${table.state} NOT IN ('closed', 'skipped')`),
  ],
);

// Each posted review is one round. The marker in its body finds a post whose answer was lost.
export const reviewRounds = sqliteTable(
  "review_rounds",
  {
    requestId: text("request_id")
      .notNull()
      .references(() => reviewRequests.id, { onDelete: "cascade" }),
    number: integer().notNull(),
    trigger: text().notNull(),
    reviewedCommit: text("reviewed_commit").notNull(),
    draft: text().notNull(),
    event: text().notNull(),
    body: text().notNull(),
    marker: text().notNull(),
    outcome: text().notNull(),
    reviewId: text("review_id"),
    reviewUrl: text("review_url"),
    postedAt: text("posted_at"),
    // The head-move limit facts when the round posts against an older reviewed commit.
    warning: text(),
    // The short text of each open blocker, for the Slack reply of the round.
    blockers: text(),
  },
  (table) => [primaryKey({ columns: [table.requestId, table.number] })],
);

// Each thread reply or unresolve of a round. A restart finds a lost reply by its marker.
export const reviewThreadOperations = sqliteTable(
  "review_thread_operations",
  {
    requestId: text("request_id").notNull(),
    round: integer().notNull(),
    threadId: text("thread_id").notNull(),
    kind: text().notNull(),
    body: text(),
    marker: text(),
    state: text().notNull(),
    detail: text(),
  },
  (table) => [
    primaryKey({ columns: [table.requestId, table.round, table.threadId, table.kind] }),
    foreignKey({
      columns: [table.requestId, table.round],
      foreignColumns: [reviewRounds.requestId, reviewRounds.number],
    }).onDelete("cascade"),
  ],
);

// The cursor of the watched Slack channel. An agent reads the channel and the CLI ingests the result.
export const slackWatches = sqliteTable("slack_watches", {
  channel: text().primaryKey(),
  // The newest Slack message ts that an ingest saw. The next read starts after it.
  cursor: text().notNull(),
  // The last ingest. The next read is due five minutes after it, or at once while paging.
  readAt: text("read_at"),
  // While Slack pages older messages: the upper bound of the next read, and the newest ts seen.
  latest: text(),
  pending: text(),
});

// A reply or a reaction that the CLI generated and an agent transports through Slack MCP tools.
// An acknowledgement marks it done. A pending effect survives a restart.
export const slackEffects = sqliteTable(
  "slack_effects",
  {
    id: text().primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => reviewRequests.id, { onDelete: "cascade" }),
    // One effect for each key: `reaction:<name>` once per request, `reply:<round>` once per round.
    key: text().notNull(),
    kind: text().notNull(),
    channel: text().notNull(),
    threadTs: text("thread_ts").notNull(),
    content: text().notNull(),
    state: text().notNull(),
    createdAt: text("created_at").notNull(),
    doneAt: text("done_at"),
    // The Slack ts of a sent reply, when the acknowledgement names one.
    slackTs: text("slack_ts"),
    // The last refused acknowledgement. The effect stays pending.
    failure: text(),
  },
  (table) => [uniqueIndex("one_effect_per_key").on(table.requestId, table.key)],
);
