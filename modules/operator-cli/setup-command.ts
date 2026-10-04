import { ProjectSetup } from "../project-setup/main.ts";
import { type ParsedArguments, targetFlag } from "./arguments.ts";
import { approvalGate, refusalReport, report } from "./result.ts";

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

export async function runPlan(parsed: ParsedArguments): Promise<void> {
  const plan = await ProjectSetup.plan({ projectRoot: process.cwd(), targets: parsed.targets });
  if (plan.conflicts.length > 0) {
    report({ json: parsed.json, ...conflictReport(plan, "setup_plan") });
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

type Report = Omit<Parameters<typeof report>[0], "json">;
type ApplyResult = Awaited<ReturnType<typeof ProjectSetup.apply>>;
type RollbackResult = Awaited<ReturnType<typeof ProjectSetup.rollback>>;
type ByStatus<R extends { status: string }> = { [S in R["status"]]: Extract<R, { status: S }> };
type ReportTable<M> = { [S in keyof M]: (result: M[S], parsed: ParsedArguments) => Report };

/** Reports one setup result through the row of its status. */
function reportStatus<M, S extends keyof M>(
  table: ReportTable<M>,
  status: S,
  result: M[S],
  parsed: ParsedArguments,
): void {
  report({ json: parsed.json, ...table[status](result, parsed) });
}

function unreadableJournal(operation: "setup_apply" | "setup_rollback", detail: string): Report {
  return {
    result: {
      outcome: "conflict",
      reason: "unreadable_journal",
      blockers: [{ reason: "unreadable_journal", detail }],
      operation,
    },
    lines: [`The setup recovery record cannot be read: ${detail}`],
  };
}

function conflictReport(plan: Plan, operation: "setup_plan" | "setup_apply"): Report {
  return {
    result: {
      outcome: "conflict",
      reason: "setup_conflict",
      blockers: plan.conflicts.map((conflict) => ({ ...conflict })),
      operation,
      data: planData(plan),
    },
    lines: conflictLines(plan),
  };
}

function approvalReport(stale: boolean, plan: Plan, parsed: ParsedArguments): Report {
  return refusalReport(
    "setup_apply",
    approvalGate({
      stale,
      ids: { currentPlanId: plan.planId, approvedPlanId: parsed.approvedPlan ?? null },
      headline: {
        required: "Setup needs an approved plan. Nothing was written.",
        stale:
          "The approved plan no longer matches this project or these targets. Nothing was written.",
      },
      lines: planLines(plan),
      data: planData(plan),
    }),
  );
}

const APPLY_REPORTS: ReportTable<ByStatus<ApplyResult>> = {
  unreadable: (result) => unreadableJournal("setup_apply", result.detail),
  "recovery-pending": () => ({
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
  }),
  conflict: (result) => conflictReport(result.plan, "setup_apply"),
  "approval-required": (result, parsed) => approvalReport(false, result.plan, parsed),
  "approval-stale": (result, parsed) => approvalReport(true, result.plan, parsed),
  unchanged: (result) => ({
    result: {
      outcome: "completed",
      reason: "already_configured",
      blockers: [],
      operation: "setup_apply",
      data: { ...planData(result.plan), applied: [] },
    },
    lines: ["The project already matches this Operator release. Nothing was written."],
  }),
  interrupted: (result) => ({
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
  }),
  applied: (result) => ({
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
  }),
};

const ROLLBACK_REPORTS: ReportTable<ByStatus<RollbackResult>> = {
  unreadable: (result) => unreadableJournal("setup_rollback", result.detail),
  nothing: () => ({
    result: {
      outcome: "completed",
      reason: "nothing_to_restore",
      blockers: [],
      operation: "setup_rollback",
    },
    lines: ["There is no interrupted setup to roll back."],
  }),
  complete: () => ({
    result: {
      outcome: "completed",
      reason: "setup_complete",
      blockers: [],
      operation: "setup_rollback",
    },
    lines: ["The recorded setup plan is complete. There is nothing to roll back."],
  }),
  conflict: (result) => ({
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
  }),
  restored: (result) => ({
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
  }),
};

export async function runApply(parsed: ParsedArguments): Promise<void> {
  const result = await ProjectSetup.apply({
    projectRoot: process.cwd(),
    targets: parsed.targets,
    approvedPlanId: parsed.approvedPlan,
  });
  reportStatus(APPLY_REPORTS, result.status, result, parsed);
}

export async function runRollback(parsed: ParsedArguments): Promise<void> {
  const result = await ProjectSetup.rollback({ projectRoot: process.cwd() });
  reportStatus(ROLLBACK_REPORTS, result.status, result, parsed);
}
