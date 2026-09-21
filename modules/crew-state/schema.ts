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

export const crewStateSchema = {
  stateMeta,
  operatorOwnership,
  workSources,
  assignments,
  assignmentDependencies,
  attempts,
  requestRecords,
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
  sql`create table request_records (
    id text primary key,
    operation text not null,
    input_identity text not null,
    outcome text not null,
    recorded_at text not null
  ) strict`,
  sql`create unique index attempts_one_active
    on attempts (assignment_id) where state = 'active'`,
];

/** The declared column names and null rules of one table, used by the drift test. */
export function declaredColumns(
  table: (typeof crewStateSchema)[keyof typeof crewStateSchema],
): Array<{ name: string; notNull: boolean }> {
  return Object.values(getTableColumns(table))
    .map((column) => ({ name: column.name, notNull: column.notNull || column.primary }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}
