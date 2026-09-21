import { getTableColumns, sql } from "drizzle-orm";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The durable shape of the crew state. A reader that finds a higher version refuses the file,
 * so this number changes only when an older Operator release can no longer read the tables.
 */
export const STATE_VERSION = 1;

export const stateMeta = sqliteTable("state_meta", {
  id: integer("id").primaryKey(),
  stateVersion: integer("state_version").notNull(),
  createdAt: text("created_at").notNull(),
});

export const operatorOwnership = sqliteTable("operator_ownership", {
  id: integer("id").primaryKey(),
  token: text("token").notNull(),
  ownerLabel: text("owner_label").notNull(),
  acquiredAt: text("acquired_at").notNull(),
  revision: integer("revision").notNull(),
});

export const workSources = sqliteTable("work_sources", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  revision: text("revision").notNull(),
  tracker: text("tracker").notNull(),
  orderIndex: integer("order_index").notNull(),
  registeredAt: text("registered_at").notNull(),
});

export const assignments = sqliteTable("assignments", {
  id: text("id").primaryKey(),
  sourceId: text("source_id")
    .notNull()
    .references(() => workSources.id),
  sourceKey: text("source_key").notNull(),
  sourceRevision: text("source_revision").notNull(),
  title: text("title").notNull(),
  kind: text("kind").notNull(),
  orderIndex: integer("order_index").notNull(),
  approvedScope: text("approved_scope").notNull(),
  acceptanceRequirements: text("acceptance_requirements").notNull(),
  permissions: text("permissions").notNull(),
  fixedInputs: text("fixed_inputs").notNull(),
  fixedInputsIdentity: text("fixed_inputs_identity").notNull(),
  state: text("state").notNull(),
  revision: integer("revision").notNull(),
  registeredAt: text("registered_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const assignmentDependencies = sqliteTable(
  "assignment_dependencies",
  {
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => assignments.id),
    dependsOnId: text("depends_on_id")
      .notNull()
      .references(() => assignments.id),
  },
  (table) => [primaryKey({ columns: [table.assignmentId, table.dependsOnId] })],
);

export const attempts = sqliteTable("attempts", {
  id: text("id").primaryKey(),
  assignmentId: text("assignment_id")
    .notNull()
    .references(() => assignments.id),
  ownerToken: text("owner_token").notNull(),
  state: text("state").notNull(),
  revision: integer("revision").notNull(),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
});

/**
 * The fixed launch plan of one attempt, written before any external effect.
 * Its snapshot is what recovery restores, so a later default never reaches a running attempt.
 */
export const attemptDispatch = sqliteTable("attempt_dispatch", {
  attemptId: text("attempt_id")
    .primaryKey()
    .references(() => attempts.id),
  assignmentId: text("assignment_id")
    .notNull()
    .references(() => assignments.id),
  baseCommit: text("base_commit").notNull(),
  branch: text("branch").notNull(),
  worktreePath: text("worktree_path").notNull(),
  snapshot: text("snapshot").notNull(),
  snapshotIdentity: text("snapshot_identity").notNull(),
  briefIdentity: text("brief_identity").notNull(),
  promptIdentity: text("prompt_identity").notNull(),
  agentName: text("agent_name").notNull(),
  agentKind: text("agent_kind").notNull(),
  agentHost: text("agent_host").notNull(),
  workspaceId: text("workspace_id"),
  paneId: text("pane_id"),
  acknowledgedAt: text("acknowledged_at"),
  inspection: text("inspection"),
  inspectionIdentity: text("inspection_identity"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * One row per external effect an attempt intends or performed.
 * The intent is written before the call, so an interrupted launch is reconciled against Herdr
 * instead of being repeated into a second writer.
 */
export const externalOperations = sqliteTable("external_operations", {
  id: text("id").primaryKey(),
  attemptId: text("attempt_id")
    .notNull()
    .references(() => attempts.id),
  kind: text("kind").notNull(),
  requestId: text("request_id").notNull(),
  intent: text("intent").notNull(),
  state: text("state").notNull(),
  detail: text("detail"),
  startedAt: text("started_at").notNull(),
  settledAt: text("settled_at"),
});

/**
 * One row per completed mutation request. A repeated request identity returns the recorded
 * outcome instead of repeating the effect, so an interrupted caller recovers its own result.
 */
export const requestRecords = sqliteTable("request_records", {
  id: text("id").primaryKey(),
  operation: text("operation").notNull(),
  inputIdentity: text("input_identity").notNull(),
  outcome: text("outcome").notNull(),
  recordedAt: text("recorded_at").notNull(),
});

/**
 * One blocked report from an Operative. It records the question, its evidence, its options,
 * the recommendation, the scope that waits, and the work that continues without the answer.
 * Its revision changes whenever the question or its target changes, which makes a recorded
 * answer stale rather than silently applicable.
 */
export const questions = sqliteTable("questions", {
  id: text("id").primaryKey(),
  assignmentId: text("assignment_id")
    .notNull()
    .references(() => assignments.id),
  attemptId: text("attempt_id")
    .notNull()
    .references(() => attempts.id),
  revision: integer("revision").notNull(),
  state: text("state").notNull(),
  report: text("report").notNull(),
  targetIdentity: text("target_identity").notNull(),
  escalationTriggers: text("escalation_triggers").notNull(),
  answerId: text("answer_id"),
  deliveryOperationId: text("delivery_operation_id"),
  deliveredAt: text("delivered_at"),
  acknowledgedAt: text("acknowledged_at"),
  raisedAt: text("raised_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * One recorded answer to one question revision.
 * The exact words stay in their own column, so a structured reading can never replace what a
 * person or an approved source actually said.
 */
export const answers = sqliteTable("answers", {
  id: text("id").primaryKey(),
  questionId: text("question_id")
    .notNull()
    .references(() => questions.id),
  questionRevision: integer("question_revision").notNull(),
  targetIdentity: text("target_identity").notNull(),
  authority: text("authority").notNull(),
  exactText: text("exact_text"),
  interpretation: text("interpretation").notNull(),
  sourceId: text("source_id"),
  sourceRevision: text("source_revision"),
  reusedFromId: text("reused_from_id"),
  approvalId: text("approval_id"),
  recordedAt: text("recorded_at").notNull(),
});

/**
 * One approval of one exact action. It binds the action, its targets, its scope, and the
 * revision of the request it was granted against, and a revocation ends it.
 */
export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  action: text("action").notNull(),
  targets: text("targets").notNull(),
  scope: text("scope").notNull(),
  requestRevision: text("request_revision").notNull(),
  exactText: text("exact_text").notNull(),
  state: text("state").notNull(),
  revision: integer("revision").notNull(),
  grantedAt: text("granted_at").notNull(),
  revokedAt: text("revoked_at"),
});

export const crewStateSchema = {
  stateMeta,
  operatorOwnership,
  workSources,
  assignments,
  assignmentDependencies,
  attempts,
  attemptDispatch,
  externalOperations,
  requestRecords,
  questions,
  answers,
  approvals,
};

/**
 * The tables this release creates. `schema.test.ts` compares every statement against the
 * Drizzle definitions above, so the two renderings cannot disagree.
 */
export const CREATE_STATEMENTS = [
  sql`create table state_meta (
    id integer primary key,
    state_version integer not null,
    created_at text not null
  ) strict`,
  sql`create table operator_ownership (
    id integer primary key,
    token text not null,
    owner_label text not null,
    acquired_at text not null,
    revision integer not null
  ) strict`,
  sql`create table work_sources (
    id text primary key,
    kind text not null,
    revision text not null,
    tracker text not null,
    order_index integer not null,
    registered_at text not null
  ) strict`,
  sql`create table assignments (
    id text primary key,
    source_id text not null references work_sources(id),
    source_key text not null,
    source_revision text not null,
    title text not null,
    kind text not null,
    order_index integer not null,
    approved_scope text not null,
    acceptance_requirements text not null,
    permissions text not null,
    fixed_inputs text not null,
    fixed_inputs_identity text not null,
    state text not null,
    revision integer not null,
    registered_at text not null,
    updated_at text not null,
    unique (source_id, source_key)
  ) strict`,
  sql`create table assignment_dependencies (
    assignment_id text not null references assignments(id),
    depends_on_id text not null references assignments(id),
    primary key (assignment_id, depends_on_id)
  ) strict`,
  sql`create table attempts (
    id text primary key,
    assignment_id text not null references assignments(id),
    owner_token text not null,
    state text not null,
    revision integer not null,
    started_at text not null,
    ended_at text
  ) strict`,
  sql`create table attempt_dispatch (
    attempt_id text primary key references attempts(id),
    assignment_id text not null references assignments(id),
    base_commit text not null,
    branch text not null,
    worktree_path text not null,
    snapshot text not null,
    snapshot_identity text not null,
    brief_identity text not null,
    prompt_identity text not null,
    agent_name text not null,
    agent_kind text not null,
    agent_host text not null,
    workspace_id text,
    pane_id text,
    acknowledged_at text,
    inspection text,
    inspection_identity text,
    created_at text not null,
    updated_at text not null
  ) strict`,
  sql`create table external_operations (
    id text primary key,
    attempt_id text not null references attempts(id),
    kind text not null,
    request_id text not null,
    intent text not null,
    state text not null,
    detail text,
    started_at text not null,
    settled_at text
  ) strict`,
  sql`create table request_records (
    id text primary key,
    operation text not null,
    input_identity text not null,
    outcome text not null,
    recorded_at text not null
  ) strict`,
  sql`create table questions (
    id text primary key,
    assignment_id text not null references assignments(id),
    attempt_id text not null references attempts(id),
    revision integer not null,
    state text not null,
    report text not null,
    target_identity text not null,
    escalation_triggers text not null,
    answer_id text,
    delivery_operation_id text,
    delivered_at text,
    acknowledged_at text,
    raised_at text not null,
    updated_at text not null
  ) strict`,
  sql`create table answers (
    id text primary key,
    question_id text not null references questions(id),
    question_revision integer not null,
    target_identity text not null,
    authority text not null,
    exact_text text,
    interpretation text not null,
    source_id text,
    source_revision text,
    reused_from_id text,
    approval_id text,
    recorded_at text not null
  ) strict`,
  sql`create table approvals (
    id text primary key,
    action text not null,
    targets text not null,
    scope text not null,
    request_revision text not null,
    exact_text text not null,
    state text not null,
    revision integer not null,
    granted_at text not null,
    revoked_at text
  ) strict`,
  sql`create unique index attempts_one_active
    on attempts (assignment_id) where state = 'active'`,
  sql`create unique index external_operations_live
    on external_operations (attempt_id, kind) where state <> 'failed'
      and kind in ('worktree_create', 'input_preparation', 'agent_start', 'prompt_delivery')`,
  sql`create unique index questions_one_open
    on questions (attempt_id) where state <> 'resolved'`,
];

/** The declared column names and null rules of one table, used by the drift test. */
export function declaredColumns(
  table: (typeof crewStateSchema)[keyof typeof crewStateSchema],
): Array<{ name: string; notNull: boolean }> {
  return Object.values(getTableColumns(table))
    .map((column) => ({ name: column.name, notNull: column.notNull || column.primary }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}
