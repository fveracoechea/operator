import { Database } from "bun:sqlite";
import { STATE_VERSION } from "./schema.ts";

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
