import { ContentIdentity } from "../content-identity/main.ts";
import { CrewState } from "../crew-state/main.ts";
import { OperatorRelease } from "../operator-release/main.ts";
import { ReleaseInstall } from "../release-install/main.ts";
import { SkillInstall } from "../skill-install/main.ts";
import { backupTargets } from "./backup.ts";

export type UpdateTarget = "opencode" | "claude-code";

export type UpdateRequest = {
  projectRoot: string;
  targets: UpdateTarget[];
  delivery: "github-source" | "jsr";
  commit: string;
  packageVersion: string | null;
};

export type UpdateBlocker = {
  reason:
    | "assignments_active"
    | "skill_copy_modified"
    | "state_version_unsupported"
    | "unreadable_state"
    | "unmigratable_state"
    | "code_submission_waiting"
    | "unreadable_selection"
    | "lock_data_missing"
    | "package_version_required"
    | "release_commit_mismatch"
    | "package_version_mismatch";
  detail: string;
  nextAction: string;
  paths: string[];
};

function blocker(
  reason: UpdateBlocker["reason"],
  detail: string,
  nextAction: string,
  paths: string[] = [],
): UpdateBlocker {
  return { reason, detail, nextAction, paths };
}

/**
 * Inspects everything one update would change, and everything that stops it. Writes nothing.
 * The identity covers the release it moves to, the skills it would write, the recorded formats
 * it would migrate, and the records it would back up, so an approval never survives a change to
 * any of them.
 */
type ReleaseSelection = Parameters<typeof ReleaseInstall.select>[0]["selection"];

type UpdatePlanBody = {
  from: ReleaseSelection | null;
  to: {
    delivery: "github-source" | "jsr";
    version: string;
    commit: string;
    packageVersion: string | null;
    releaseIdentity: string;
    skillsIdentity: string;
  };
  targets: UpdateTarget[];
  skills: {
    install: Array<{ skill: string; target: UpdateTarget; path: string }>;
    conflicts: Array<{ skill: string; target: UpdateTarget; paths: string[] }>;
  };
  migration: ReturnType<typeof CrewState.migration>;
  backup: { targets: string[] };
  blockers: UpdateBlocker[];
};

/** The crew state stops an update while work is in flight or its format cannot move forward. */
function crewStateBlockers(
  activity: ReturnType<typeof CrewState.activity>,
  migration: ReturnType<typeof CrewState.migration>,
): UpdateBlocker[] {
  const blockers: UpdateBlocker[] = [];
  if (activity.status === "unreadable") {
    blockers.push(
      blocker(
        "unreadable_state",
        `The crew state cannot be read: ${activity.detail}`,
        "Decide what the crew state should be, then plan the update again.",
        [activity.path],
      ),
    );
  }

  if (activity.status === "read" && activity.active.length > 0) {
    blockers.push(
      blocker(
        "assignments_active",
        `This crew holds ${activity.active.length} assignment(s) that are still in flight: ${activity.active
          .map((one) => `${one.assignmentId} (${one.state})`)
          .join(", ")}.`,
        "Finish, accept, or invalidate the work in flight, then plan the update again.",
      ),
    );
  }

  if (migration.status === "unsupported") {
    blockers.push(
      blocker("state_version_unsupported", migration.detail, "Install a newer Operator release.", [
        migration.path,
      ]),
    );
  }
  if (migration.status === "unmigratable") {
    blockers.push(
      blocker(
        "unmigratable_state",
        migration.detail,
        "This release cannot carry that format forward. Report it rather than replacing the file.",
        [migration.path],
      ),
    );
  }

  if (migration.status === "held") {
    blockers.push(
      blocker(
        "code_submission_waiting",
        [migration.detail, ...migration.holds].join(" "),
        "Finish review and acceptance of each named submission under the earlier release, then plan the update again.",
        [migration.path],
      ),
    );
  }

  return blockers;
}

/** The recorded installation stops an update when its selection or a skill copy is not what this release wrote. */
function installBlockers(
  recorded: Awaited<ReturnType<typeof ReleaseInstall.selection>>,
  skills: Awaited<ReturnType<typeof SkillInstall.inspect>>,
): UpdateBlocker[] {
  const blockers: UpdateBlocker[] = [];
  if (recorded.state === "unreadable") {
    blockers.push(
      blocker(
        "unreadable_selection",
        `The recorded release selection cannot be read: ${recorded.detail}`,
        "Decide what the recorded selection should be, then plan the update again.",
        [ReleaseInstall.paths().selection],
      ),
    );
  }

  if (skills.conflicts.length > 0) {
    blockers.push(
      blocker(
        "skill_copy_modified",
        `${skills.conflicts.length} installed skill copy or copies differ from this Operator release.`,
        "Restore or remove each changed copy, then plan the update again.",
        skills.conflicts.flatMap((one) => one.paths),
      ),
    );
  }

  return blockers;
}

/** The running release stops an update that names a release it is not. */
function releaseBlockers(
  running: Awaited<ReturnType<typeof OperatorRelease.identify>>,
  request: UpdateRequest,
): UpdateBlocker[] {
  const blockers: UpdateBlocker[] = [];
  if (running.lock.state === "missing") {
    blockers.push(
      blocker(
        "lock_data_missing",
        "The running Operator installation holds no lock data, so the release it would record is not reproducible.",
        "Reinstall Operator so the installation keeps its own lock data, then plan the update again.",
      ),
    );
  }

  // A release that carries its own record knows which commit and version it is. The project
  // records the release that is running, so it never records one nobody verified. A checkout
  // carries no such record, and nothing is checked against a record that does not exist.
  if (running.commit !== null && running.commit !== request.commit) {
    blockers.push(
      blocker(
        "release_commit_mismatch",
        `The running Operator release was built from commit ${running.commit}, and this update names ${request.commit}.`,
        "Name the commit the running release was built from, or run the release that commit built.",
      ),
    );
  }

  if (
    request.delivery === "jsr" &&
    request.packageVersion !== null &&
    running.artifact === "built" &&
    request.packageVersion !== running.version
  ) {
    blockers.push(
      blocker(
        "package_version_mismatch",
        `The running Operator release is version ${running.version}, and this update names the published version ${request.packageVersion}.`,
        "Name the version the running release is, or run the release that version holds.",
      ),
    );
  }

  if (request.delivery === "jsr" && request.packageVersion === null) {
    blockers.push(
      blocker(
        "package_version_required",
        "A registry installation is selected by an exact package version, and none was given.",
        "Pass --package-version with the exact published version.",
      ),
    );
  }

  return blockers;
}

export async function computeUpdatePlan(request: UpdateRequest): Promise<UpdatePlan> {
  const running = await OperatorRelease.identify();
  const [recorded, activity, migration, skills, backups] = await Promise.all([
    ReleaseInstall.selection({ projectRoot: request.projectRoot }),
    Promise.resolve(CrewState.activity({ projectRoot: request.projectRoot })),
    Promise.resolve(CrewState.migration({ projectRoot: request.projectRoot })),
    SkillInstall.inspect({ projectRoot: request.projectRoot, targets: request.targets }),
    backupTargets(request.projectRoot),
  ]);

  const blockers = [
    ...crewStateBlockers(activity, migration),
    ...installBlockers(recorded, skills),
    ...releaseBlockers(running, request),
  ];

  const to = {
    delivery: request.delivery,
    version: running.version,
    commit: request.commit,
    packageVersion: request.packageVersion,
    releaseIdentity: running.identity,
    skillsIdentity: running.skillsIdentity,
  };

  const plan: UpdatePlanBody = {
    from: recorded.state === "selected" ? recorded.selection : null,
    to,
    targets: request.targets.toSorted(),
    skills: { install: skills.missing, conflicts: skills.conflicts },
    migration,
    backup: { targets: backups },
    blockers,
  };

  return { ...plan, updateId: identify(plan) };
}

export type UpdatePlan = UpdatePlanBody & { updateId: string };

function identify(plan: UpdatePlanBody): string {
  return ContentIdentity.ofText(
    JSON.stringify({
      from: plan.from,
      to: plan.to,
      targets: plan.targets,
      skills: plan.skills,
      migration: { found: plan.migration.found, steps: plan.migration.steps },
      backup: plan.backup.targets,
    }),
  );
}
