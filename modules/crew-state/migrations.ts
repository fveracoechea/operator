import { Database } from "bun:sqlite";
import { GATE_TABLES, INTEGRATION_TABLES, LANDING_TABLES, STATE_VERSION } from "./schema.ts";

/**
 * One step from one recorded state version to the next.
 * A step changes the file in place inside one transaction, so a step that cannot finish leaves
 * the version it started from and the backup the update verified is what restores it.
 */
export type MigrationStep = {
  from: number;
  to: number;
  summary: string;
  apply: (sqlite: Database) => void;
  // What in the file this step cannot carry forward, one line each. Any line stops the step.
  holds?: (sqlite: Database) => string[];
};

type WaitingRow = { id: string; assignment_id: string };

export const MIGRATIONS: MigrationStep[] = [
  {
    from: 1,
    to: 2,
    summary: "Record the Operator release this crew coordinates under in the state file.",
    apply: (sqlite) => {
      sqlite.exec("alter table state_meta add column release_identity text");
    },
  },
  {
    from: 2,
    to: 3,
    summary: "Record how the quote of each requirement answer was checked against its source.",
    apply: (sqlite) => {
      sqlite.exec("alter table answers add column source_kind text");
      // An earlier release checked no quote, so its requirements say so rather than claim a copy.
      sqlite.exec("update answers set source_kind = 'unchecked' where authority = 'requirement'");
    },
  },
  {
    from: 3,
    to: 4,
    summary: "Record each code result as one commit, with no pull request.",
    // An accepted record keeps its pull request as history, and its reader ignores it. A result
    // that still waits was produced under the pull request rules, so it finishes under them.
    holds: (sqlite) =>
      sqlite
        .query<WaitingRow, []>(
          // Rework adds a new submission and leaves the old row as it was, so only the newest
          // submission of an assignment that still awaits review is work in flight.
          `select s.id, s.assignment_id from submissions s
           join assignments a on a.id = s.assignment_id
           where s.code is not null and s.state = 'awaiting-review' and a.state = 'awaiting-review'
             and s.assignment_revision = (
               select max(o.assignment_revision) from submissions o where o.assignment_id = s.assignment_id
             )
           order by s.submitted_at, s.id`,
        )
        .all()
        .map(
          (row) =>
            `Code submission ${row.id} of assignment ${row.assignment_id} waits for review or acceptance.`,
        ),
    apply: () => {},
  },
  {
    from: 4,
    to: 5,
    summary: "Record the scan around each Operative worktree and each change found outside it.",
    // An attempt launched before this step has no "before" scan, so its submission records the
    // scan as not run and acceptance waits for a disposition, as it does for any outside change.
    apply: (sqlite) => {
      sqlite.exec("alter table attempt_dispatch add column outside_scan text");
      sqlite.exec(`create table outside_changes (
        id text primary key,
        submission_id text not null references submissions(id),
        place text not null,
        path text not null,
        change text not null,
        before text,
        after text,
        security integer not null,
        disposition text,
        reason text,
        evidence text,
        approval_id text,
        disposed_at text,
        recorded_at text not null,
        unique (submission_id, place, path)
      ) strict`);
    },
  },
  {
    from: 5,
    to: 6,
    summary: "Record the behavior changes of each result submission, each with its basis.",
    // An earlier submission listed none, so it keeps no list rather than claim "none".
    apply: (sqlite) => {
      sqlite.exec("alter table submissions add column behavior_changes text");
    },
  },
  {
    from: 6,
    to: 7,
    summary:
      "Record the planning record of each planning acceptance and the type of planning work.",
    apply: (sqlite) => {
      // Planning work that an earlier release registered keeps no type, so its decisions follow
      // the stricter rule of a grilling. Planning work it accepted keeps no record: nobody made
      // the claim that a record would state.
      sqlite.exec("alter table assignments add column planning_type text");
      sqlite.exec(`create table planning_records (
        id text primary key,
        assignment_id text not null references assignments(id),
        assignment_revision integer not null,
        entries text not null,
        artifacts text not null,
        identity text not null,
        recorded_at text not null
      ) strict`);
    },
  },
  {
    from: 7,
    to: 8,
    summary: "Record the planning records that each launch carried in its brief.",
    // A launch recorded before this step carried no planning records, so it keeps no list. A
    // recovery of it reads the latest record of each dependency, as a new launch does.
    apply: (sqlite) => {
      sqlite.exec("alter table attempt_dispatch add column planning_record_ids text");
    },
  },
  {
    from: 8,
    to: 9,
    summary:
      "Record the issue text identity of each assignment and the repository of each tracker binding.",
    apply: (sqlite) => {
      sqlite.exec("alter table assignments add column scope_identity text");
      // An earlier source held one repository for all its items, so each binding takes it. A
      // binding whose source has no location already refused every tracker update, and it keeps
      // refusing as a binding with no ticket.
      sqlite.exec(
        `update assignments set tracker_binding = case
           when (select tracker_location from work_sources where id = assignments.source_id) is null
             then null
           else json_object(
             'repository',
             json_extract(
               (select tracker_location from work_sources where id = assignments.source_id),
               '$.repository'
             ),
             'issue',
             json_extract(tracker_binding, '$.issue')
           )
         end
         where tracker_binding is not null`,
      );
    },
  },
  {
    from: 9,
    to: 10,
    summary: "Record each gate run, its command outcomes, and the gate checkout of each source.",
    // A source that an earlier release dispatched has its base already in use, so it is not
    // gated again. Only a source with no production dispatch waits for a gate run at its base.
    apply: (sqlite) => {
      for (const statement of GATE_TABLES) {
        sqlite.exec(statement);
      }
    },
  },
  {
    from: 10,
    to: 11,
    summary: "Record the registration plan revision under which each assignment was withdrawn.",
    // An earlier release could not withdraw an assignment, so every row keeps no revision.
    apply: (sqlite) => {
      sqlite.exec("alter table assignments add column withdrawn_under text");
    },
  },
  {
    from: 11,
    to: 12,
    summary: "Record the integration branch of each source, its base, its tip, and its gate.",
    // A source that an earlier release dispatched has no branch, and its later dispatches keep the
    // commit the caller names. Only a source with no production dispatch gets a branch.
    apply: (sqlite) => {
      for (const statement of INTEGRATION_TABLES) {
        sqlite.exec(statement);
      }
    },
  },
  {
    from: 12,
    to: 13,
    summary: "Record each landing of an accepted code result on its integration branch.",
    // An earlier release landed nothing, so no landing is recorded, and an accepted result keeps
    // its reviewed commit as the commit that carries it.
    apply: (sqlite) => {
      for (const statement of LANDING_TABLES) {
        sqlite.exec(statement);
      }
    },
  },
];

/** The steps that carry one recorded version up to the version this release reads. */
export function pendingSteps(found: number): MigrationStep[] {
  const steps: MigrationStep[] = [];
  for (let version = found; version < STATE_VERSION; version += 1) {
    const step = MIGRATIONS.find((one) => one.from === version);
    if (step === undefined) {
      return steps;
    }
    steps.push(step);
  }

  return steps;
}

/** True when every version between the recorded one and this release has a step to carry it. */
export function isMigratable(found: number): boolean {
  return (
    found <= STATE_VERSION &&
    pendingSteps(found).length === STATE_VERSION - found &&
    (found === STATE_VERSION || pendingSteps(found).at(-1)?.to === STATE_VERSION)
  );
}
