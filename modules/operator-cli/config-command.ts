import { OperatorConfig } from "../operator-config/main.ts";
import type { ParsedArguments } from "./arguments.ts";
import {
  answer,
  approvalRefusals,
  type Refusal,
  type Refusals,
  report,
  reportRefusal,
} from "./result.ts";

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

/** Repeats the edits that produced this plan, so the approval names the same change. */
function approvalCommand(parsed: ParsedArguments, plan: Plan): string {
  const edits = [
    ...parsed.configSets.map((edit) => ["--set", edit] as const),
    ...parsed.configUnsets.map((path) => ["--unset", path] as const),
  ];
  // A value with a shell character is quoted, so the printed command runs as shown.
  const word = (text: string) =>
    /^[\w./=:@+,-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
  return [
    "operator config apply",
    ...edits.map(([flag, value]) => `${flag} ${word(value)}`),
    `--approved-plan ${plan.planId}`,
  ].join(" ");
}

function planLines(parsed: ParsedArguments, plan: Plan): string[] {
  return [
    `Configuration plan ${plan.planId}: ${plan.changed ? "change" : "no change"} to ${plan.path}.`,
    `Current file (${plan.previousIdentity}):`,
    plan.previousText,
    `Proposed file (${plan.nextIdentity}):`,
    plan.nextText,
    `Approve with: ${approvalCommand(parsed, plan)}`,
  ];
}

type Applied = Awaited<ReturnType<typeof OperatorConfig.applyChange>>;

function failure(
  result:
    | { status: "missing" }
    | { status: "invalid"; issues: string[] }
    | { status: "invalid-input"; issues: string[] },
): Refusal {
  if (result.status === "missing") {
    const issues = ["This project has no Operator configuration."];
    // The JSON writer gives a next action the project invocation, so the command runs as shown.
    const nextAction = "Run `operator setup plan`, then apply the approved plan.";
    return {
      outcome: "missing-condition",
      reason: "not_configured",
      detail: { path: OperatorConfig.configPath(), issues, nextAction },
      lines: [...issues, nextAction],
    };
  }
  const invalidInput = result.status === "invalid-input";
  return {
    outcome: invalidInput ? "invalid" : "conflict",
    reason: invalidInput ? "invalid_config_change" : "invalid_configuration",
    detail: { path: OperatorConfig.configPath(), issues: result.issues },
    lines: result.issues,
  };
}

const RECOVER_ACTION =
  "Run `operator config recover`. If it still refuses, ask the person what the configuration should hold.";

function recovery(detail: string): Refusal {
  return {
    outcome: "conflict",
    reason: "config_recovery_required",
    detail: { detail, nextAction: RECOVER_ACTION },
    lines: [detail, RECOVER_ACTION],
  };
}

function locked(detail: string): Refusal {
  return {
    outcome: "conflict",
    reason: "config_write_locked",
    detail: { detail },
    lines: ["Another configuration write holds the project lock. Retry after it finishes.", detail],
  };
}

export async function runShow(parsed: ParsedArguments): Promise<void> {
  const result = await OperatorConfig.show(process.cwd());
  if (result.status !== "read") {
    reportRefusal(parsed, "config_show", failure(result));
    return;
  }
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

export async function runPlan(parsed: ParsedArguments): Promise<void> {
  const result = await OperatorConfig.planChange({
    projectRoot: process.cwd(),
    sets: parsed.configSets,
    unsets: parsed.configUnsets,
  });
  if (result.status === "recovery-required") {
    reportRefusal(parsed, "config_plan", recovery(result.detail));
    return;
  }
  if (result.status !== "planned") {
    reportRefusal(parsed, "config_plan", failure(result));
    return;
  }
  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: result.changed ? "config_plan_ready" : "config_unchanged",
      blockers: [],
      operation: "config_plan",
      data: planData(result),
    },
    lines: planLines(parsed, result),
  });
}

/** The answer to each config apply status that writes nothing. */
function applyRefusals(parsed: ParsedArguments) {
  return {
    "write-locked": (result) => locked(result.detail),
    missing: failure,
    invalid: failure,
    "invalid-input": failure,
    "recovery-required": (result) => recovery(result.detail),
    "write-failed": (result) => ({
      outcome: "failed",
      reason: "config_write_failed",
      detail: { detail: result.detail, nextAction: RECOVER_ACTION },
      lines: [result.detail, RECOVER_ACTION],
    }),
    ...approvalRefusals((result: Extract<Applied, { status: `approval-${string}` }>) => ({
      ids: { approvedPlanId: parsed.approvedPlan ?? null, currentPlanId: result.plan.planId },
      staleOutcome: "conflict",
      headline: {
        required: "Approval is required. Nothing was written.",
        stale: "The file or proposed edit changed. Nothing was written.",
      },
      lines: planLines(parsed, result.plan),
      data: planData(result.plan),
    })),
  } satisfies Refusals<Applied>;
}

export async function runApply(parsed: ParsedArguments): Promise<void> {
  const result = await OperatorConfig.applyChange({
    projectRoot: process.cwd(),
    sets: parsed.configSets,
    unsets: parsed.configUnsets,
    approvedPlanId: parsed.approvedPlan,
  });
  if (answer(parsed, "config_apply", result, applyRefusals(parsed))) return;
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

export async function runRecover(parsed: ParsedArguments): Promise<void> {
  const result = await OperatorConfig.recoverChange(process.cwd());
  if (result.status === "write-locked") {
    reportRefusal(parsed, "config_recover", locked(result.detail));
    return;
  }
  if (result.status === "write-failed" || result.status === "recovery-required") {
    reportRefusal(parsed, "config_recover", recovery(result.detail));
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
