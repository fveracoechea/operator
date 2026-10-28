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
    // The verified merge. Cleanup compares each resource with this head before it disposes it.
    mergedHead: text("merged_head"),
    mergeCommit: text("merge_commit"),
    mergedAt: text("merged_at"),
    // The stack parent and the parent-merge relay progress of a PR stacked on a parent PR.
    relay: text("relay"),
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
    assignment: text("assignment").notNull(),
    // The launch whose pane and worktree are disposed.
    launchId: text("launch_id")
      .notNull()
      .references(() => launches.id),
    // The next step to run. Earlier steps are done, and a finished cleanup has no step.
    step: text("step"),
    state: text("state").notNull(),
    reason: text("reason"),
    detail: text("detail"),
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

// A review request is not an assignment. One request per PR is open until it is closed or skipped.
// An approved request stays open, because a renewed request reopens it with the same reviewer.
export const reviewRequests = sqliteTable(
  "review_requests",
  {
    id: text("id").primaryKey(),
    repository: text("repository")
      .notNull()
      .references(() => projects.repository, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    url: text("url").notNull(),
    // `slack` also covers a manual addition. `assignment` is the optional reviewer of a PR assignment.
    origin: text("origin").notNull(),
    sourceId: text("source_id"),
    assignment: text("assignment"),
    state: text("state").notNull(),
    requestedAt: text("requested_at").notNull(),
    endedAt: text("ended_at"),
    // The reviewer launch. Its branch is local and Operator never pushes it.
    launchState: text("launch_state"),
    launch: text("launch"),
    name: text("name").unique(),
    branch: text("branch"),
    head: text("head"),
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
    trigger: text("trigger"),
    headMoves: integer("head_moves").notNull().default(0),
    // While watching: the last author activity, the stale mark, and the reviewer's resolved threads.
    activityAt: text("activity_at"),
    staleAt: text("stale_at"),
    resolvedThreads: text("resolved_threads"),
    // A reviewer move or prompt that a wait or a post decided and has not finished.
    sync: text("sync"),
    // Reviewer cleanup after the request is closed or skipped.
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
    number: integer("number").notNull(),
    trigger: text("trigger").notNull(),
    reviewedCommit: text("reviewed_commit").notNull(),
    draft: text("draft").notNull(),
    event: text("event").notNull(),
    body: text("body").notNull(),
    marker: text("marker").notNull(),
    outcome: text("outcome").notNull(),
    reviewId: text("review_id"),
    reviewUrl: text("review_url"),
    postedAt: text("posted_at"),
    // The head-move limit facts when the round posts against an older reviewed commit.
    warning: text("warning"),
    // The short text of each open blocker, for the Slack reply of the round.
    blockers: text("blockers"),
  },
  (table) => [primaryKey({ columns: [table.requestId, table.number] })],
);

// Each thread reply or unresolve of a round. A restart finds a lost reply by its marker.
export const reviewThreadOperations = sqliteTable(
  "review_thread_operations",
  {
    requestId: text("request_id").notNull(),
    round: integer("round").notNull(),
    threadId: text("thread_id").notNull(),
    kind: text("kind").notNull(),
    body: text("body"),
    marker: text("marker"),
    state: text("state").notNull(),
    detail: text("detail"),
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
  channel: text("channel").primaryKey(),
  // The newest Slack message ts that an ingest saw. The next read starts after it.
  cursor: text("cursor").notNull(),
  // The last ingest. The next read is due five minutes after it, or at once while paging.
  readAt: text("read_at"),
  // While Slack pages older messages: the upper bound of the next read, and the newest ts seen.
  latest: text("latest"),
  pending: text("pending"),
});

// A reply or a reaction that the CLI generated and an agent transports through Slack MCP tools.
// An acknowledgement marks it done. A pending effect survives a restart.
export const slackEffects = sqliteTable(
  "slack_effects",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => reviewRequests.id, { onDelete: "cascade" }),
    // One effect for each key: `reaction:<name>` once per request, `reply:<round>` once per round.
    key: text("key").notNull(),
    kind: text("kind").notNull(),
    channel: text("channel").notNull(),
    threadTs: text("thread_ts").notNull(),
    content: text("content").notNull(),
    state: text("state").notNull(),
    createdAt: text("created_at").notNull(),
    doneAt: text("done_at"),
    // The Slack ts of a sent reply, when the acknowledgement names one.
    slackTs: text("slack_ts"),
    // The last refused acknowledgement. The effect stays pending.
    failure: text("failure"),
  },
  (table) => [uniqueIndex("one_effect_per_key").on(table.requestId, table.key)],
);
