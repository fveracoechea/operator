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
};

export const MIGRATIONS: MigrationStep[] = [
  {
    from: 1,
    to: 2,
    summary: "Record the Operator release this crew coordinates under in the state file.",
    apply: (sqlite) => {
      sqlite.exec("alter table state_meta add column release_identity text");
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
