import { OperatorConfig } from "../operator-config/main.ts";
import { hasConfigArguments, type ParsedArguments } from "./arguments.ts";
import { type Handled, report } from "./result.ts";

type Plan = Extract<Awaited<ReturnType<typeof OperatorConfig.planChange>>, { status: "planned" }>;

function planData(plan: Plan) {
  return {
    path: plan.path,
    planId: plan.planId,
    editsIdentity: plan.editsIdentity,
    previousIdentity: plan.previousIdentity,
    nextIdentity: plan.nextIdentity,
    previousText: plan.previousText,
    nextText: plan.nextText,
    before: plan.before,
    after: plan.after,
    selection: plan.selection,
    changed: plan.changed,
  };
}

function planLines(plan: Plan): string[] {
  return [
    `Configuration plan ${plan.planId}: ${plan.changed ? "change" : "no change"} to ${plan.path}.`,
    `Current file (${plan.previousIdentity}):`,
    plan.previousText,
    `Proposed file (${plan.nextIdentity}):`,
    plan.nextText,
    "Apply this plan with the same --set and --unset flags and --approved-plan <planId>.",
  ];
}

function reportFailure(
  parsed: ParsedArguments,
  operation: "config_show" | "config_plan" | "config_apply",
  result:
    | { status: "missing" }
    | { status: "invalid"; issues: string[] }
    | { status: "invalid-input"; issues: string[] },
): void {
  const missing = result.status === "missing";
  const invalidInput = result.status === "invalid-input";
  const reason = missing
    ? "not_configured"
    : invalidInput
      ? "invalid_config_change"
      : "invalid_configuration";
  const issues = missing ? ["Run operator setup first."] : result.issues;
  report({
    json: parsed.json,
    result: {
      outcome: missing ? "missing-condition" : invalidInput ? "invalid" : "conflict",
      reason,
      blockers: [{ reason, path: OperatorConfig.configPath(), issues }],
      operation,
    },
    lines: issues,
  });
}

async function show(parsed: ParsedArguments): Promise<void> {
  const result = await OperatorConfig.show(process.cwd());
  if (result.status !== "read") return reportFailure(parsed, "config_show", result);
  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "already_configured",
      blockers: [],
      operation: "config_show",
      data: {
        path: OperatorConfig.configPath(),
        identity: result.identity,
        config: result.config,
        selection: result.selection,
      },
    },
    lines: [
      `${OperatorConfig.configPath()} (${result.identity}):`,
      result.text,
      `Effective selection: ${JSON.stringify(result.selection)}`,
    ],
  });
}

async function plan(parsed: ParsedArguments): Promise<void> {
  const result = await OperatorConfig.planChange({
    projectRoot: process.cwd(),
    sets: parsed.configSets,
    unsets: parsed.configUnsets,
  });
  if (result.status === "recovery-required")
    return reportRecovery(parsed, "config_plan", result.detail);
  if (result.status !== "planned") return reportFailure(parsed, "config_plan", result);
  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: result.changed ? "config_plan_ready" : "config_unchanged",
      blockers: [],
      operation: "config_plan",
      data: planData(result),
    },
    lines: planLines(result),
  });
}

async function apply(parsed: ParsedArguments): Promise<void> {
  const result = await OperatorConfig.applyChange({
    projectRoot: process.cwd(),
    sets: parsed.configSets,
    unsets: parsed.configUnsets,
    approvedPlanId: parsed.approvedPlan,
  });
  if (result.status === "write-locked") return reportLocked(parsed, "config_apply", result.detail);
  if (
    result.status === "missing" ||
    result.status === "invalid" ||
    result.status === "invalid-input"
  ) {
    return reportFailure(parsed, "config_apply", result);
  }
  if (result.status === "recovery-required") {
    return reportRecovery(parsed, "config_apply", result.detail);
  }
  if (result.status === "write-failed") {
    report({
      json: parsed.json,
      result: {
        outcome: "failed",
        reason: "config_write_failed",
        blockers: [{ reason: "config_write_failed", detail: result.detail }],
        operation: "config_apply",
      },
      lines: [result.detail, "Inspect the configuration and the apply record before retrying."],
    });
    return;
  }
  if (result.status === "approval-required" || result.status === "approval-stale") {
    const stale = result.status === "approval-stale";
    const reason = stale ? "approval_stale" : "approval_required";
    report({
      json: parsed.json,
      result: {
        outcome: stale ? "conflict" : "missing-condition",
        reason,
        blockers: [
          {
            reason,
            approvedPlanId: parsed.approvedPlan ?? null,
            currentPlanId: result.plan.planId,
          },
        ],
        operation: "config_apply",
        data: planData(result.plan),
      },
      lines: [
        stale
          ? "The file or proposed edit changed. Nothing was written."
          : "Approval is required. Nothing was written.",
        ...planLines(result.plan),
      ],
    });
    return;
  }
  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: result.status === "applied" ? "config_applied" : "config_unchanged",
      blockers: [],
      operation: "config_apply",
      data:
        result.status === "applied"
          ? { ...planData(result.plan), repeated: false }
          : result.plan === undefined
            ? { repeated: result.repeated }
            : { repeated: result.repeated, ...planData(result.plan) },
    },
    lines: [
      result.status === "applied"
        ? `Applied configuration plan ${result.plan.planId}.`
        : result.repeated
          ? "This configuration plan already applied. Nothing was written."
          : "The configuration already matches the approved plan. Nothing was written.",
    ],
  });
}

function reportRecovery(
  parsed: ParsedArguments,
  operation: "config_plan" | "config_apply" | "config_recover",
  detail: string,
): void {
  report({
    json: parsed.json,
    result: {
      outcome: "conflict",
      reason: "config_recovery_required",
      blockers: [{ reason: "config_recovery_required", detail }],
      operation,
    },
    lines: [detail, "Inspect the configuration and the apply record before retrying."],
  });
}

async function recover(parsed: ParsedArguments): Promise<void> {
  const result = await OperatorConfig.recoverChange(process.cwd());
  if (result.status === "write-locked")
    return reportLocked(parsed, "config_recover", result.detail);
  if (result.status === "write-failed") {
    return reportRecovery(parsed, "config_recover", result.detail);
  }
  if (result.status === "recovery-required") {
    reportRecovery(parsed, "config_recover", result.detail);
    return;
  }
  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: result.status === "settled" ? "config_recovered" : "config_unchanged",
      blockers: [],
      operation: "config_recover",
      data: result,
    },
    lines: [
      result.status === "settled"
        ? `Plan ${result.planId} ${result.state === "complete" ? "wrote the configuration" : "left the configuration unchanged"}. The apply record is settled.`
        : "No configuration apply needs recovery.",
    ],
  });
}

function reportLocked(
  parsed: ParsedArguments,
  operation: "config_apply" | "config_recover",
  detail: string,
): void {
  report({
    json: parsed.json,
    result: {
      outcome: "conflict",
      reason: "config_write_locked",
      blockers: [{ reason: "config_write_locked", detail }],
      operation,
    },
    lines: ["Another configuration write holds the project lock. Retry after it finishes.", detail],
  });
}

export async function runConfig(words: string[], parsed: ParsedArguments): Promise<Handled> {
  if (words.length !== 1) return "invalid-arguments";
  if (words[0] === "show") {
    if (hasConfigArguments(parsed) || parsed.approvedPlan !== undefined) return "invalid-arguments";
    await show(parsed);
    return "reported";
  }
  if (words[0] === "plan") {
    if (parsed.approvedPlan !== undefined) return "invalid-arguments";
    await plan(parsed);
    return "reported";
  }
  if (words[0] === "apply") {
    await apply(parsed);
    return "reported";
  }
  if (words[0] === "recover") {
    if (hasConfigArguments(parsed) || parsed.approvedPlan !== undefined) return "invalid-arguments";
    await recover(parsed);
    return "reported";
  }
  return "invalid-arguments";
}
