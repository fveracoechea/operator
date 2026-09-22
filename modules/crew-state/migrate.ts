import { openForMigration } from "./database.ts";
import { isMigratable, type MigrationStep, pendingSteps } from "./migrations.ts";
import { STATE_VERSION } from "./schema.ts";
import { readActivity } from "./activity.ts";

export type MigrationPlan = {
  path: string;
  present: boolean;
  found: number | null;
  supported: number;
  steps: Array<{ from: number; to: number; summary: string }>;
  status: "current" | "migratable" | "unsupported" | "unmigratable" | "missing" | "unreadable";
  detail: string;
};

function described(steps: MigrationStep[]) {
  return steps.map((step) => ({ from: step.from, to: step.to, summary: step.summary }));
}

/** Reports what the recorded crew state would need before this release may read it. */
export function planMigration(projectRoot: string): MigrationPlan {
  const activity = readActivity(projectRoot);
  const base = { supported: STATE_VERSION, steps: [] as MigrationPlan["steps"] };

  if (activity.status === "missing") {
    return {
      ...base,
      path: activity.path,
      present: false,
      found: null,
      status: "missing",
      detail: "This project holds no crew state, so nothing is migrated.",
    };
  }
  if (activity.status === "unreadable") {
    return {
      ...base,
      path: activity.path,
      present: true,
      found: null,
      status: "unreadable",
      detail: `The crew state cannot be read: ${activity.detail}`,
    };
  }

  const found = activity.stateVersion;
  if (found > STATE_VERSION) {
    return {
      ...base,
      path: activity.path,
      present: true,
      found,
      status: "unsupported",
      detail: `The crew state is at version ${found}, and this release reads version ${STATE_VERSION}.`,
    };
  }
  if (found === STATE_VERSION) {
    return {
      ...base,
      path: activity.path,
      present: true,
      found,
      status: "current",
      detail: `The crew state is already at version ${STATE_VERSION}.`,
    };
  }

  const steps = pendingSteps(found);
  return {
    path: activity.path,
    present: true,
    found,
    supported: STATE_VERSION,
    steps: described(steps),
    status: isMigratable(found) ? "migratable" : "unmigratable",
    detail: isMigratable(found)
      ? `The crew state moves from version ${found} to version ${STATE_VERSION}.`
      : `No recorded step carries version ${found} to version ${STATE_VERSION}.`,
  };
}

export type MigrationOutcome =
  | { status: "migrated"; from: number; to: number; steps: MigrationPlan["steps"] }
  | { status: "unchanged"; version: number }
  | { status: "skipped"; reason: MigrationPlan["status"]; detail: string }
  | { status: "failed"; from: number; failedStep: { from: number; to: number }; detail: string };

/**
 * Carries the recorded crew state up to the version this release reads.
 * Each step and the version it records move together in one transaction, so an interrupted
 * migration leaves the version it started from and the verified backup is what restores it.
 */
export function migrateState(request: {
  projectRoot: string;
  releaseIdentity: string;
}): MigrationOutcome {
  const plan = planMigration(request.projectRoot);
  if (plan.status === "current" && plan.found !== null) {
    recordRelease(request.projectRoot, request.releaseIdentity);
    return { status: "unchanged", version: plan.found };
  }
  if (plan.status !== "migratable" || plan.found === null) {
    return { status: "skipped", reason: plan.status, detail: plan.detail };
  }

  const from = plan.found;
  const sqlite = openForMigration(request.projectRoot);
  try {
    for (const step of pendingSteps(from)) {
      try {
        sqlite.exec("begin immediate");
        step.apply(sqlite);
        sqlite.query("update state_meta set state_version = ? where id = 1").run(step.to);
        sqlite.exec("commit");
      } catch (error) {
        try {
          sqlite.exec("rollback");
        } catch {
          // The transaction was already closed by the failure, so there is nothing to undo.
        }
        return {
          status: "failed",
          from,
          failedStep: { from: step.from, to: step.to },
          detail: String(error),
        };
      }
    }

    sqlite
      .query("update state_meta set release_identity = ? where id = 1")
      .run(request.releaseIdentity);
  } finally {
    sqlite.close();
  }

  return { status: "migrated", from, to: STATE_VERSION, steps: plan.steps };
}

function recordRelease(projectRoot: string, releaseIdentity: string): void {
  const sqlite = openForMigration(projectRoot);
  try {
    sqlite.query("update state_meta set release_identity = ? where id = 1").run(releaseIdentity);
  } finally {
    sqlite.close();
  }
}
