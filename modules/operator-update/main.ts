import { CrewState } from "../crew-state/main.ts";
import { ReleaseInstall } from "../release-install/main.ts";
import { SkillInstall } from "../skill-install/main.ts";
import { restoreBackup, takeBackup } from "./backup.ts";
import { computeUpdatePlan, type UpdateRequest } from "./plan.ts";

export const OperatorUpdate = {
  /** Inspects everything one update would change, and everything that stops it. Writes nothing. */
  async plan(request: UpdateRequest) {
    return computeUpdatePlan(request);
  },

  /**
   * Updates the CLI code and the owned skills of one project together, under one approval.
   * Nothing is written while work is in flight. The durable records are copied aside and read
   * back before the recorded formats move, so a migration that fails is put back rather than
   * left half done.
   */
  async apply(request: UpdateRequest & { approvedUpdateId: string | undefined }) {
    const plan = await computeUpdatePlan(request);
    if (plan.blockers.length > 0) {
      return { status: "blocked" as const, plan };
    }
    if (request.approvedUpdateId === undefined) {
      return { status: "approval-required" as const, plan };
    }
    if (request.approvedUpdateId !== plan.updateId) {
      return { status: "approval-stale" as const, plan };
    }

    const backup = await takeBackup({
      projectRoot: request.projectRoot,
      updateId: plan.updateId,
    });
    if (backup.status === "unverified") {
      return { status: "backup-unverified" as const, plan, backup };
    }

    const migration = CrewState.migrate({
      projectRoot: request.projectRoot,
      releaseIdentity: plan.to.releaseIdentity,
    });
    if (migration.status === "failed") {
      const restored = await restoreBackup({ projectRoot: request.projectRoot, backup });
      return { status: "migration-failed" as const, plan, backup, migration, restored };
    }

    // The code and the skills it ships move together, so a project never runs one release of
    // the CLI against the workflow instructions of another.
    const installed = await SkillInstall.run({
      projectRoot: request.projectRoot,
      targets: request.targets,
    });
    if (installed.conflicts.length > 0) {
      const restored = await restoreBackup({ projectRoot: request.projectRoot, backup });
      return { status: "skills-conflicted" as const, plan, backup, installed, restored };
    }

    const selected = await ReleaseInstall.select({
      projectRoot: request.projectRoot,
      selection: {
        schemaVersion: 1,
        delivery: plan.to.delivery,
        version: plan.to.version,
        commit: plan.to.commit,
        releaseIdentity: plan.to.releaseIdentity,
        skillsIdentity: plan.to.skillsIdentity,
        packageVersion: plan.to.packageVersion,
        upstreamSkills: plan.from?.upstreamSkills ?? [],
        selectedAt: new Date().toISOString(),
      },
    });
    if (selected.status === "invalid") {
      const restored = await restoreBackup({ projectRoot: request.projectRoot, backup });
      return {
        status: "selection-invalid" as const,
        plan,
        backup,
        issues: selected.issues,
        restored,
      };
    }

    return {
      status: "updated" as const,
      plan,
      backup,
      migration,
      installed: installed.installed,
      adopted: installed.adopted,
      selection: selected.selection,
      written: selected.written,
      commands: ReleaseInstall.commands({ selection: selected.selection }),
    };
  },
};
