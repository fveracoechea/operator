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
 * The fixed result one attempt handed over for review.
 * A submission never accepts the assignment; it moves it to awaiting review and pins every
 * revision, artifact, check, concern, and decision the review reads.
 */
export const submissions = sqliteTable("submissions", {
  id: text("id").primaryKey(),
  assignmentId: text("assignment_id")
    .notNull()
    .references(() => assignments.id),
  attemptId: text("attempt_id")
    .notNull()
    .references(() => attempts.id),
  resultKind: text("result_kind").notNull(),
  assignmentRevision: integer("assignment_revision").notNull(),
  sourceRevision: text("source_revision").notNull(),
  requirementsIdentity: text("requirements_identity").notNull(),
  artifacts: text("artifacts").notNull(),
  artifactsIdentity: text("artifacts_identity").notNull(),
  checks: text("checks").notNull(),
  concerns: text("concerns").notNull(),
  decisions: text("decisions").notNull(),
  code: text("code"),
  reviewBase: text("review_base"),
  identity: text("identity").notNull(),
  state: text("state").notNull(),
  revision: integer("revision").notNull(),
  submittedAt: text("submitted_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * One separate review of one submission, held by its own review assignment.
 * The two axis reports live beside it, so an incomplete review is visible as a missing axis
 * rather than as an absent record.
 */
export const reviews = sqliteTable("reviews", {
  id: text("id").primaryKey(),
  submissionId: text("submission_id")
    .notNull()
    .references(() => submissions.id),
  assignmentId: text("assignment_id")
    .notNull()
    .references(() => assignments.id),
  axes: text("axes").notNull(),
  state: text("state").notNull(),
  host: text("host"),
  subAgents: text("sub_agents"),
  blocker: text("blocker"),
  reportedAt: text("reported_at"),
  revision: integer("revision").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** One axis report of one review. The two axes stay separate and are never merged. */
export const reviewReports = sqliteTable("review_reports", {
  id: text("id").primaryKey(),
  reviewId: text("review_id")
    .notNull()
    .references(() => reviews.id),
  axis: text("axis").notNull(),
  summary: text("summary").notNull(),
  checked: text("checked").notNull(),
  observedChecks: text("observed_checks").notNull(),
  findingCount: integer("finding_count").notNull(),
  identity: text("identity").notNull(),
  recordedAt: text("recorded_at").notNull(),
});

/**
 * One finding of one axis report, with the Operator disposition it carries.
 * A finding with no disposition blocks acceptance, so no finding disappears in silence.
 */
export const reviewFindings = sqliteTable("review_findings", {
  id: text("id").primaryKey(),
  reviewId: text("review_id")
    .notNull()
    .references(() => reviews.id),
  axis: text("axis").notNull(),
  findingKey: text("finding_key").notNull(),
  severity: text("severity").notNull(),
  summary: text("summary").notNull(),
  evidence: text("evidence").notNull(),
  disposition: text("disposition"),
  reason: text("reason"),
  dispositionEvidence: text("disposition_evidence"),
  followUp: text("follow_up"),
  disposedAt: text("disposed_at"),
  recordedAt: text("recorded_at").notNull(),
});

/**
 * One delegated correction round on one assignment.
 * It fixes the accepted findings, the conflicts it must settle, and the revisions it combines,
 * so the fresh Operative that takes it receives evidence the Operator cannot change afterwards.
 */
export const reworkCycles = sqliteTable("rework_cycles", {
  id: text("id").primaryKey(),
  assignmentId: text("assignment_id")
    .notNull()
    .references(() => assignments.id),
  submissionId: text("submission_id")
    .notNull()
    .references(() => submissions.id),
  reviewId: text("review_id").references(() => reviews.id),
  reason: text("reason").notNull(),
  cycleIndex: integer("cycle_index").notNull(),
  brief: text("brief").notNull(),
  briefIdentity: text("brief_identity").notNull(),
  attemptId: text("attempt_id").references(() => attempts.id),
  approvalId: text("approval_id"),
  state: text("state").notNull(),
  openedAt: text("opened_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * One reached limit, recorded as the direction it asks the user for.
 * It blocks acceptance while it is open, and its revision moves every time the limit is reached
 * again, so an approval granted against an earlier request no longer covers the new one.
 */
export const directionRequests = sqliteTable("direction_requests", {
  id: text("id").primaryKey(),
  assignmentId: text("assignment_id")
    .notNull()
    .references(() => assignments.id),
  limitKind: text("limit_kind").notNull(),
  limitValue: integer("limit_value").notNull(),
  evidence: text("evidence").notNull(),
  state: text("state").notNull(),
  approvalId: text("approval_id"),
  revision: integer("revision").notNull(),
  raisedAt: text("raised_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * One defect found in an accepted result. The accepted record stays, because history is what
 * says which dependents read the invalid result and why they were paused.
 */
export const invalidations = sqliteTable("invalidations", {
  id: text("id").primaryKey(),
  assignmentId: text("assignment_id")
    .notNull()
    .references(() => assignments.id),
  submissionId: text("submission_id")
    .notNull()
    .references(() => submissions.id),
  defect: text("defect").notNull(),
  dependents: text("dependents").notNull(),
  recordedAt: text("recorded_at").notNull(),
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
  operatorEscalation: text("operator_escalation"),
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
  submissions,
  reviews,
  reviewReports,
  reviewFindings,
  reworkCycles,
  directionRequests,
  invalidations,
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
  sql`create table submissions (
    id text primary key,
    assignment_id text not null references assignments(id),
    attempt_id text not null references attempts(id),
    result_kind text not null,
    assignment_revision integer not null,
    source_revision text not null,
    requirements_identity text not null,
    artifacts text not null,
    artifacts_identity text not null,
    checks text not null,
    concerns text not null,
    decisions text not null,
    code text,
    review_base text,
    identity text not null,
    state text not null,
    revision integer not null,
    submitted_at text not null,
    updated_at text not null,
    unique (attempt_id)
  ) strict`,
  sql`create table reviews (
    id text primary key,
    submission_id text not null references submissions(id),
    assignment_id text not null references assignments(id),
    axes text not null,
    state text not null,
    host text,
    sub_agents text,
    blocker text,
    reported_at text,
    revision integer not null,
    created_at text not null,
    updated_at text not null,
    unique (assignment_id)
  ) strict`,
  sql`create table review_reports (
    id text primary key,
    review_id text not null references reviews(id),
    axis text not null,
    summary text not null,
    checked text not null,
    observed_checks text not null,
    finding_count integer not null,
    identity text not null,
    recorded_at text not null,
    unique (review_id, axis)
  ) strict`,
  sql`create table review_findings (
    id text primary key,
    review_id text not null references reviews(id),
    axis text not null,
    finding_key text not null,
    severity text not null,
    summary text not null,
    evidence text not null,
    disposition text,
    reason text,
    disposition_evidence text,
    follow_up text,
    disposed_at text,
    recorded_at text not null,
    unique (review_id, axis, finding_key)
  ) strict`,
  sql`create table rework_cycles (
    id text primary key,
    assignment_id text not null references assignments(id),
    submission_id text not null references submissions(id),
    review_id text references reviews(id),
    reason text not null,
    cycle_index integer not null,
    brief text not null,
    brief_identity text not null,
    attempt_id text references attempts(id),
    approval_id text,
    state text not null,
    opened_at text not null,
    updated_at text not null
  ) strict`,
  sql`create table direction_requests (
    id text primary key,
    assignment_id text not null references assignments(id),
    limit_kind text not null,
    limit_value integer not null,
    evidence text not null,
    state text not null,
    approval_id text,
    revision integer not null,
    raised_at text not null,
    updated_at text not null,
    unique (assignment_id, limit_kind)
  ) strict`,
  sql`create table invalidations (
    id text primary key,
    assignment_id text not null references assignments(id),
    submission_id text not null references submissions(id),
    defect text not null,
    dependents text not null,
    recorded_at text not null
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
    operator_escalation text,
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
  sql`create unique index rework_cycles_one_open
    on rework_cycles (assignment_id) where state = 'open'`,
  sql`create unique index questions_one_open
    on questions (attempt_id) where state in ('open', 'answered', 'delivered')`,
];

/** The declared column names and null rules of one table, used by the drift test. */
export function declaredColumns(
  table: (typeof crewStateSchema)[keyof typeof crewStateSchema],
): Array<{ name: string; notNull: boolean }> {
  return Object.values(getTableColumns(table))
    .map((column) => ({ name: column.name, notNull: column.notNull || column.primary }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}
