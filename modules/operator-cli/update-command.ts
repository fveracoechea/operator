import { OperatorUpdate } from "../operator-update/main.ts";
import type { ParsedArguments } from "./arguments.ts";
import { reportMissingTarget } from "./missing-target.ts";
import { type Handled, refuse, report } from "./result.ts";

type Plan = Awaited<ReturnType<typeof OperatorUpdate.plan>>;

function planData(plan: Plan) {
  return {
    updateId: plan.updateId,
    from: plan.from,
    to: plan.to,
    targets: plan.targets,
    skills: plan.skills,
    migration: plan.migration,
    backup: plan.backup,
  };
}

function planLines(plan: Plan): string[] {
  const from =
    plan.from === null
      ? "This project has selected no Operator release yet."
      : `Selected now: Operator ${plan.from.version} from ${plan.from.delivery} at commit ${plan.from.commit}.`;

  return [
    `Operator update plan ${plan.updateId}`,
    from,
    `Selecting: Operator ${plan.to.version} from ${plan.to.delivery} at commit ${plan.to.commit}.`,
    ...(plan.to.packageVersion === null
      ? []
      : [`Registry package version: ${plan.to.packageVersion}.`]),
    `Targets: ${plan.targets.join(", ")}`,
    `Crew state: ${plan.migration.detail}`,
    ...plan.migration.steps.map((step) => `  ${step.from} -> ${step.to}: ${step.summary}`),
    plan.backup.targets.length === 0
      ? "There is no durable record to back up."
      : "Backed up and read back before anything moves:",
    ...plan.backup.targets.map((path) => `  ${path}`),
    plan.skills.install.length === 0
      ? "Every owned skill copy already matches this release."
      : "Installed with the CLI code:",
    ...plan.skills.install.map((one) => `  ${one.path}`),
  ];
}

function reportBlocked(
  parsed: ParsedArguments,
  plan: Plan,
  operation: "update_plan" | "update_apply",
): void {
  report({
    json: parsed.json,
    result: {
      outcome: plan.blockers.some((one) => one.reason === "assignments_active")
        ? "missing-condition"
        : "conflict",
      reason: "update_blocked",
      blockers: plan.blockers.map((one) => ({ ...one })),
      operation,
      data: planData(plan),
    },
    lines: [
      "Nothing was written. These conditions stop the update:",
      ...plan.blockers.flatMap((one) => [
        `  ${one.reason}: ${one.detail}`,
        `    Next: ${one.nextAction}`,
      ]),
    ],
  });
}

/** A release is selected by a full commit, and a registry path also by an exact version. */
function readSelectors(parsed: ParsedArguments) {
  const delivery = parsed.delivery ?? "github-source";
  const commit = parsed.crew.baseCommit;
  return commit === undefined || !/^[0-9a-f]{40}$/.test(commit)
    ? null
    : { delivery, commit, packageVersion: parsed.packageVersion ?? null };
}

async function runPlan(parsed: ParsedArguments): Promise<Handled> {
  const selectors = readSelectors(parsed);
  if (selectors === null) {
    return "invalid-arguments";
  }

  const plan = await OperatorUpdate.plan({
    projectRoot: process.cwd(),
    targets: parsed.targets,
    ...selectors,
  });
  if (plan.blockers.length > 0) {
    reportBlocked(parsed, plan, "update_plan");
    return "reported";
  }

  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "update_plan_ready",
      blockers: [],
      operation: "update_plan",
      data: planData(plan),
    },
    lines: [
      ...planLines(plan),
      "",
      `Approve with: operator update apply ${parsed.targets.map((one) => (one === "opencode" ? "--opencode" : "--claude")).join(" ")} --commit ${plan.to.commit} --approved-update ${plan.updateId}`,
    ],
  });
  return "reported";
}

async function runApply(parsed: ParsedArguments): Promise<Handled> {
  const selectors = readSelectors(parsed);
  if (selectors === null) {
    return "invalid-arguments";
  }

  const result = await OperatorUpdate.apply({
    projectRoot: process.cwd(),
    targets: parsed.targets,
    approvedUpdateId: parsed.approvedUpdate,
    ...selectors,
  });

  if (result.status === "blocked") {
    reportBlocked(parsed, result.plan, "update_apply");
    return "reported";
  }

  if (result.status === "approval-required" || result.status === "approval-stale") {
    const stale = result.status === "approval-stale";
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: stale ? "approval_stale" : "approval_required",
        blockers: [
          {
            reason: stale ? "approval_stale" : "approval_required",
            currentUpdateId: result.plan.updateId,
            approvedUpdateId: parsed.approvedUpdate ?? null,
          },
        ],
        operation: "update_apply",
        data: planData(result.plan),
      },
      lines: [
        stale
          ? "The approved update no longer matches this project or this release. Nothing was written."
          : "The update needs an approved plan. Nothing was written.",
        ...planLines(result.plan),
      ],
    });
    return "reported";
  }

  if (result.status === "backup-unverified") {
    return refuse({
      json: parsed.json,
      operation: "update_apply",
      outcome: "failed",
      reason: "backup_unverified",
      detail: { root: result.backup.root, failed: result.backup.failed },
      lines: [
        "The backup of these durable records did not read back as written, so nothing was migrated:",
        ...result.backup.failed.map((path) => `  ${path}`),
      ],
    });
  }

  if (result.status === "migration-failed") {
    return refuse({
      json: parsed.json,
      operation: "update_apply",
      outcome: "failed",
      reason: "migration_failed",
      detail: {
        from: result.migration.from,
        failedStep: result.migration.failedStep,
        detail: result.migration.detail,
        restored: result.restored.restored,
        unrestored: result.restored.failed,
      },
      lines: [
        `The crew state could not move from version ${result.migration.from}: ${result.migration.detail}`,
        result.restored.status === "restored"
          ? "Every backed-up record was put back exactly as it was."
          : `These records could not be put back: ${result.restored.failed.join(", ")}`,
      ],
    });
  }

  if (result.status === "skills-conflicted") {
    return refuse({
      json: parsed.json,
      operation: "update_apply",
      outcome: "conflict",
      reason: "skill_copy_conflict",
      detail: { paths: result.installed.conflicts.flatMap((one) => one.paths) },
      lines: [
        "These skill copies changed while the update ran, so no skill was installed:",
        ...result.installed.conflicts.flatMap((one) => one.paths.map((path) => `  ${path}`)),
      ],
    });
  }

  if (result.status === "selection-invalid") {
    return refuse({
      json: parsed.json,
      operation: "update_apply",
      outcome: "invalid",
      reason: "invalid_selection",
      detail: { issues: result.issues },
      lines: ["The release selection is not valid:", ...result.issues.map((one) => `  ${one}`)],
    });
  }

  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "update_applied",
      blockers: [],
      operation: "update_apply",
      data: {
        ...planData(result.plan),
        backup: { root: result.backup.root, targets: result.backup.entries.map((one) => one.path) },
        migration: result.migration,
        installed: result.installed,
        adopted: result.adopted,
        selection: result.selection,
        written: result.written,
        commands: result.commands,
      },
    },
    lines: [
      `Selected Operator ${result.selection.version} from ${result.selection.delivery} at commit ${result.selection.commit}.`,
      result.migration.status === "migrated"
        ? `Migrated the crew state from version ${result.migration.from} to ${result.migration.to}.`
        : `Crew state: ${result.migration.status}.`,
      `Backed up ${result.backup.entries.length} durable record(s) under ${result.backup.root}.`,
      ...(result.installed.length === 0
        ? ["Every owned skill copy already matched this release."]
        : ["Installed the owned skills:", ...result.installed.map((one) => `  ${one.path}`)]),
      `Run it with: ${result.commands.run}`,
    ],
  });
  return "reported";
}

export async function runUpdate(words: string[], parsed: ParsedArguments): Promise<Handled> {
  const [subcommand] = words;
  if (words.length !== 1 || (subcommand !== "plan" && subcommand !== "apply")) {
    return "invalid-arguments";
  }
  if (subcommand === "plan" && parsed.approvedUpdate !== undefined) {
    return "invalid-arguments";
  }
  if (parsed.targets.length === 0) {
    reportMissingTarget(parsed, subcommand === "plan" ? "update_plan" : "update_apply");
    return "reported";
  }

  return subcommand === "plan" ? runPlan(parsed) : runApply(parsed);
}
