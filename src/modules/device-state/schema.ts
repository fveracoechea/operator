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
    // The Herdr pane and the agent session that last ran the source's coordination wait or
    // dispatched its work. Only that session coordinates the source until a take-over.
    supervisingPane: text("supervising_pane"),
    supervisingSession: text("supervising_session"),
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
    // The resolved internal review value of this start. Older releases recorded none.
    internalReview: integer("internal_review", { mode: "boolean" }),
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
  // JSON of the ignored files that the install wrote, with a content hash each. Null before it.
  installed: text(),
});

// A PR assignment that the SuperAgent added by promoting an accepted report. ADR-0023.
// The registered plan stays unchanged, so this row holds the promoted assignment's definition.
export const promotions = sqliteTable(
  "promotions",
  {
    sourceId: text("source_id").notNull(),
    assignment: text().notNull(),
    // The promoted report assignment and its accepted report.
    report: text().notNull(),
    reportNumber: integer("report_number").notNull(),
    trackerKey: text("tracker_key").notNull(),
    instructions: text().notNull(),
    branch: text().notNull(),
    internalReview: integer("internal_review", { mode: "boolean" }),
    worktreePath: text("worktree_path").notNull(),
    // The launch that took over the report worker's pane, when that worker still ran.
    handoverLaunchId: text("handover_launch_id"),
    promotedAt: text("promoted_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.assignment] }),
    uniqueIndex("one_promotion_per_report").on(table.sourceId, table.report),
    foreignKey({
      columns: [table.sourceId, table.assignment],
      foreignColumns: [assignments.sourceId, assignments.key],
    }),
    foreignKey({
      columns: [table.sourceId, table.report],
      foreignColumns: [assignments.sourceId, assignments.key],
    }),
  ],
);

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

// The internal review of one PR assignment. The implementer's draft association records it.
export const internalReviews = sqliteTable(
  "internal_reviews",
  {
    sourceId: text("source_id").notNull(),
    assignment: text().notNull(),
    // reviewing, then ready or skipped.
    state: text().notNull(),
    // The implementer launch whose session the handoff ends.
    implementerLaunchId: text("implementer_launch_id")
      .notNull()
      .references(() => launches.id),
    // The handoff to the reviewer: pending until the reviewer launch is reserved, or failed.
    handoffState: text("handoff_state").notNull(),
    handoffDetail: text("handoff_detail"),
    startedAt: text("started_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    // The handoff process and its lease. A gone process or a stale lease is a stopped handoff.
    ownerPid: integer("owner_pid"),
    leaseAt: text("lease_at"),
    // The end of the review: the PR head it ended at, and the summary comment of a ready end.
    readyHead: text("ready_head"),
    commentId: text("comment_id"),
    commentUrl: text("comment_url"),
    endedAt: text("ended_at"),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.assignment] }),
    foreignKey({
      columns: [table.sourceId, table.assignment],
      foreignColumns: [assignments.sourceId, assignments.key],
    }),
  ],
);

// Each round of an internal review, with the head it reviewed and its validated findings.
export const internalReviewRounds = sqliteTable(
  "internal_review_rounds",
  {
    sourceId: text("source_id").notNull(),
    assignment: text().notNull(),
    number: integer().notNull(),
    launchId: text("launch_id")
      .notNull()
      .references(() => launches.id),
    head: text().notNull(),
    findings: text().notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.assignment, table.number] }),
    foreignKey({
      columns: [table.sourceId, table.assignment],
      foreignColumns: [internalReviews.sourceId, internalReviews.assignment],
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

// A WorkerAgent's question to its supervising SuperAgent, keyed within its assignment.
// Only the SuperAgent answers, and the answer records who decided.
export const workerQuestions = sqliteTable(
  "worker_questions",
  {
    sourceId: text("source_id").notNull(),
    assignment: text().notNull(),
    key: text().notNull(),
    launchId: text("launch_id")
      .notNull()
      .references(() => launches.id),
    question: text().notNull(),
    askedAt: text("asked_at").notNull(),
    state: text().notNull(),
    answer: text(),
    answeredBy: text("answered_by"),
    answeredAt: text("answered_at"),
    endedAt: text("ended_at"),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.assignment, table.key] }),
    foreignKey({
      columns: [table.sourceId, table.assignment],
      foreignColumns: [assignments.sourceId, assignments.key],
    }),
  ],
);

// A SuperAgent's steering message to a running worker, keyed within its assignment. A doorbell
// names the record, and the worker acknowledges it. An answer to a question is a message too.
export const workerMessages = sqliteTable(
  "worker_messages",
  {
    sourceId: text("source_id").notNull(),
    assignment: text().notNull(),
    key: text().notNull(),
    launchId: text("launch_id")
      .notNull()
      .references(() => launches.id),
    message: text().notNull(),
    questionKey: text("question_key"),
    sentAt: text("sent_at").notNull(),
    state: text().notNull(),
    rungAt: text("rung_at"),
    doorbellFailure: text("doorbell_failure"),
    acknowledgedAt: text("acknowledged_at"),
    reply: text(),
    endedAt: text("ended_at"),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.assignment, table.key] }),
    foreignKey({
      columns: [table.sourceId, table.assignment],
      foreignColumns: [assignments.sourceId, assignments.key],
    }),
  ],
);

// What the SuperAgent owes the person in a source, keyed within it. It stays open until the
// SuperAgent closes it, so the commitment does not depend on the conversation. ADR-0026.
export const obligations = sqliteTable(
  "obligations",
  {
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    key: text().notNull(),
    kind: text().notNull(),
    summary: text().notNull(),
    reference: text(),
    openedAt: text("opened_at").notNull(),
    state: text().notNull(),
    closedAt: text("closed_at"),
  },
  (table) => [primaryKey({ columns: [table.sourceId, table.key] })],
);

// A review request is not an assignment. One request per PR is open until it is closed or skipped.
// An approved request stays open, so a renewed request reopens it. The approval cleans up its reviewer.
export const reviewRequests = sqliteTable(
  "review_requests",
  {
    id: text().primaryKey(),
    repository: text()
      .notNull()
      .references(() => projects.repository, { onDelete: "cascade" }),
    number: integer().notNull(),
    url: text().notNull(),
    // `manual` is an explicit add. `assignment` is the optional reviewer of a PR assignment.
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
    // An optional thread permalink for a SuperAgent's status reply.
    slackThread: text("slack_thread"),
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

// The coordination wait of one scope: one source, or every source of the project when empty.
// The last returned set of non-wait actions lets a new wait return a change that came between waits.
export const coordinationWaits = sqliteTable(
  "coordination_waits",
  {
    repository: text()
      .notNull()
      .references(() => projects.repository, { onDelete: "cascade" }),
    scope: text().notNull(),
    actions: text(),
    returnedAt: text("returned_at"),
    // The waiting process, its lease, its Herdr pane, and its agent session. A gone process or a
    // stale lease is no wait.
    ownerPid: integer("owner_pid"),
    leaseAt: text("lease_at"),
    paneId: text("pane_id"),
    session: text(),
    startedAt: text("started_at"),
  },
  (table) => [primaryKey({ columns: [table.repository, table.scope] })],
);
