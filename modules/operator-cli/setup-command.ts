import { ProjectSetup } from "../project-setup/main.ts";
import { hasSelectionOrProbeArguments, type ParsedArguments, targetFlag } from "./arguments.ts";
import { runProbeApply, runProbeCleanup, runProbePlan } from "./probe-command.ts";
import { runReadiness } from "./readiness-command.ts";
import { reportMissingTarget } from "./missing-target.ts";
import { report } from "./result.ts";

type Plan = Awaited<ReturnType<typeof ProjectSetup.plan>>;

function planData(plan: Plan) {
  return {
    planId: plan.planId,
    targets: plan.targets,
    changes: plan.changes.map((change) => ({
      path: change.path,
      kind: change.kind,
      reason: change.reason,
      addedText: change.addedText,
    })),
  };
}

function planLines(plan: Plan): string[] {
  if (plan.changes.length === 0) {
    return ["The project already matches this Operator release. Setup proposes no change."];
  }

  return [
    `Operator setup plan ${plan.planId}`,
    `Targets: ${plan.targets.join(", ")}`,
    "",
    ...plan.changes.flatMap((change) => [
      `${change.kind} ${change.path}`,
      `  ${change.reason}`,
      // Every edit outside the ignored directory is shown in full; Operator's own files are not.
      ...(change.path.startsWith(".operator/")
        ? [`  | ${change.addedText.length} characters of generated Operator content`]
        : change.addedText.split("\n").map((line) => `  | ${line}`)),
      "",
    ]),
    `Approve with: operator setup apply ${plan.targets.map(targetFlag).join(" ")} --approved-plan ${plan.planId}`,
  ];
}

function conflictLines(plan: Plan): string[] {
  return [
    "Setup made no change. These conflicts need your decision:",
    ...plan.conflicts.flatMap((conflict) => [
      `  ${conflict.reason}: ${conflict.path ?? conflict.paths?.join(", ") ?? ""}`,
      `    ${conflict.detail}`,
    ]),
  ];
}

function reportConflicts(
  parsed: ParsedArguments,
  plan: Plan,
  operation: "setup_plan" | "setup_apply",
): void {
  report({
    json: parsed.json,
    result: {
      outcome: "conflict",
      reason: "setup_conflict",
      blockers: plan.conflicts.map((conflict) => ({ ...conflict })),
      operation,
      data: planData(plan),
    },
    lines: conflictLines(plan),
  });
}

async function runPlan(parsed: ParsedArguments): Promise<void> {
  const plan = await ProjectSetup.plan({ projectRoot: process.cwd(), targets: parsed.targets });
  if (plan.conflicts.length > 0) {
    reportConflicts(parsed, plan, "setup_plan");
    return;
  }

  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: plan.changes.length === 0 ? "already_configured" : "plan_ready",
      blockers: [],
      operation: "setup_plan",
      data: planData(plan),
    },
    lines: planLines(plan),
  });
}

async function runApply(parsed: ParsedArguments): Promise<void> {
  const result = await ProjectSetup.apply({
    projectRoot: process.cwd(),
    targets: parsed.targets,
    approvedPlanId: parsed.approvedPlan,
  });

  if (result.status === "unreadable") {
    reportUnreadableJournal(parsed, "setup_apply", result.detail);
    return;
  }

  if (result.status === "recovery-pending") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "setup_interrupted",
        blockers: [
          {
            reason: "setup_interrupted",
            detail: "An earlier setup plan is still incomplete. Its recovery record is pending.",
          },
        ],
        operation: "setup_apply",
      },
      lines: [
        "An earlier setup plan is still incomplete. Nothing was written.",
        "Run `operator setup rollback` first, so the recovery record is not lost.",
      ],
    });
    return;
  }

  if (result.status === "conflict") {
    reportConflicts(parsed, result.plan, "setup_apply");
    return;
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
            currentPlanId: result.plan.planId,
            approvedPlanId: parsed.approvedPlan ?? null,
          },
        ],
        operation: "setup_apply",
        data: planData(result.plan),
      },
      lines: [
        stale
          ? "The approved plan no longer matches this project or these targets. Nothing was written."
          : "Setup needs an approved plan. Nothing was written.",
        ...planLines(result.plan),
      ],
    });
    return;
  }

  if (result.status === "unchanged") {
    report({
      json: parsed.json,
      result: {
        outcome: "completed",
        reason: "already_configured",
        blockers: [],
        operation: "setup_apply",
        data: { ...planData(result.plan), applied: [] },
      },
      lines: ["The project already matches this Operator release. Nothing was written."],
    });
    return;
  }

  if (result.status === "interrupted") {
    report({
      json: parsed.json,
      result: {
        outcome: "failed",
        reason: "setup_interrupted",
        blockers: [
          {
            reason: "setup_interrupted",
            path: result.failedPath,
            detail: result.detail,
            written: result.written,
          },
        ],
        operation: "setup_apply",
        data: { ...planData(result.plan), applied: result.written },
      },
      lines: [
        `Setup stopped at ${result.failedPath}: ${result.detail}`,
        "The plan is incomplete. Run `operator setup rollback` to restore the files setup wrote.",
      ],
    });
    return;
  }

  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "setup_applied",
      blockers: [],
      operation: "setup_apply",
      data: { ...planData(result.plan), applied: result.plan.changes.map((change) => change.path) },
    },
    lines: [
      "Applied the approved Operator setup plan:",
      ...result.plan.changes.map((change) => `  ${change.kind} ${change.path}`),
    ],
  });
}

function reportUnreadableJournal(
  parsed: ParsedArguments,
  operation: "setup_apply" | "setup_rollback",
  detail: string,
): void {
  report({
    json: parsed.json,
    result: {
      outcome: "conflict",
      reason: "unreadable_journal",
      blockers: [{ reason: "unreadable_journal", detail }],
      operation,
    },
    lines: [`The setup recovery record cannot be read: ${detail}`],
  });
}

async function runRollback(parsed: ParsedArguments): Promise<void> {
  const result = await ProjectSetup.rollback({ projectRoot: process.cwd() });

  if (result.status === "unreadable") {
    reportUnreadableJournal(parsed, "setup_rollback", result.detail);
    return;
  }

  if (result.status === "nothing" || result.status === "complete") {
    const complete = result.status === "complete";
    report({
      json: parsed.json,
      result: {
        outcome: "completed",
        reason: complete ? "setup_complete" : "nothing_to_restore",
        blockers: [],
        operation: "setup_rollback",
      },
      lines: [
        complete
          ? "The recorded setup plan is complete. There is nothing to roll back."
          : "There is no interrupted setup to roll back.",
      ],
    });
    return;
  }

  if (result.status === "conflict") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "restore_conflict",
        blockers: result.conflicts.map((conflict) => ({
          reason: "restore_conflict" as const,
          path: conflict.path,
          detail: conflict.detail,
        })),
        operation: "setup_rollback",
        data: { restored: result.restored },
      },
      lines: [
        "Restored the files setup still owned:",
        ...result.restored.map((path) => `  ${path}`),
        "These files changed after setup wrote them and were preserved:",
        ...result.conflicts.map((conflict) => `  ${conflict.path}`),
      ],
    });
    return;
  }

  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "restored",
      blockers: [],
      operation: "setup_rollback",
      data: { restored: result.restored },
    },
    lines: [
      "Restored the files the interrupted setup wrote:",
      ...result.restored.map((path) => `  ${path}`),
    ],
  });
}

export async function runSetup(
  words: string[],
  parsed: ParsedArguments,
): Promise<"reported" | "invalid-arguments"> {
  const [subcommand, second] = words;

  if (subcommand === "probe") {
    if (second !== "plan" && second !== "apply" && second !== "cleanup") {
      return "invalid-arguments";
    }
    if (parsed.approvedPlan !== undefined) {
      return "invalid-arguments";
    }
    if (second === "cleanup") {
      // Cleanup names no host and no target; it disposes of what earlier runs recorded.
      if (
        parsed.targets.length > 0 ||
        parsed.approvedProbe !== undefined ||
        parsed.overrides.operator !== undefined ||
        parsed.overrides.crew !== undefined
      ) {
        return "invalid-arguments";
      }
      await runProbeCleanup(parsed);
      return "reported";
    }
    if (parsed.approvedCleanup !== undefined) {
      return "invalid-arguments";
    }
    if (second === "plan" && parsed.approvedProbe !== undefined) {
      return "invalid-arguments";
    }
    await (second === "plan" ? runProbePlan(parsed) : runProbeApply(parsed));
    return "reported";
  }

  if (words.length !== 1) {
    return "invalid-arguments";
  }

  if (subcommand === "rollback") {
    if (
      parsed.targets.length > 0 ||
      parsed.approvedPlan !== undefined ||
      hasSelectionOrProbeArguments(parsed)
    ) {
      return "invalid-arguments";
    }
    await runRollback(parsed);
    return "reported";
  }

  if (subcommand === "readiness") {
    if (parsed.approvedPlan !== undefined || parsed.approvedProbe !== undefined) {
      return "invalid-arguments";
    }
    await runReadiness(parsed);
    return "reported";
  }

  if (subcommand !== "plan" && subcommand !== "apply") {
    return "invalid-arguments";
  }

  if (
    hasSelectionOrProbeArguments(parsed) ||
    (subcommand === "plan" && parsed.approvedPlan !== undefined)
  ) {
    return "invalid-arguments";
  }

  if (parsed.targets.length === 0) {
    reportMissingTarget(parsed, subcommand === "plan" ? "setup_plan" : "setup_apply");
    return "reported";
  }

  await (subcommand === "plan" ? runPlan(parsed) : runApply(parsed));
  return "reported";
}
