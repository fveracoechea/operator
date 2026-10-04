import { SkillInstall } from "../skill-install/main.ts";
import { type ParsedArguments, targetFlag } from "./arguments.ts";
import { approvalGate, type Refusal, report } from "./result.ts";

type MattPlan = Awaited<ReturnType<typeof SkillInstall.mattPlan>>;
type MattOperation = "install_matt_plan" | "install_matt_apply";
type Verdict = Pick<Refusal, "outcome" | "reason" | "lines"> & {
  blockers: NonNullable<Refusal["blockers"]>;
};

export async function runMattPlan(parsed: ParsedArguments): Promise<void> {
  await checkUpstream(parsed, "install_matt_plan", () => planMatt(parsed));
}

export async function runMattApply(parsed: ParsedArguments<"--commit">): Promise<void> {
  await checkUpstream(parsed, "install_matt_apply", () =>
    applyMatt(parsed, parsed.crew.baseCommit),
  );
}

/** Reports an upstream that cannot be read in place of the Matt plan. */
async function checkUpstream(
  parsed: ParsedArguments,
  operation: MattOperation,
  check: () => Promise<void>,
): Promise<void> {
  try {
    await check();
  } catch (error) {
    report({
      json: parsed.json,
      result: {
        outcome: "failed",
        reason: "upstream_unavailable",
        operation,
        blockers: [{ reason: "upstream_unavailable", detail: String(error) }],
      },
      lines: [`Matt skills could not be checked: ${String(error)}`],
    });
  }
}

async function planMatt(parsed: ParsedArguments): Promise<void> {
  const plan = await SkillInstall.mattPlan({ projectRoot: process.cwd(), targets: parsed.targets });
  reportMatt(parsed, "install_matt_plan", plan, {
    outcome: "completed",
    reason: "matt_plan_ready",
    blockers: [],
    lines: [...changeLines(plan), approveLine(plan)],
  });
}

async function applyMatt(parsed: ParsedArguments, commit: string): Promise<void> {
  const result = await SkillInstall.mattApply({
    projectRoot: process.cwd(),
    targets: parsed.targets,
    commit,
    approvedPlanId: parsed.approvedPlan,
  });
  const { plan } = result;
  reportMatt(
    parsed,
    "install_matt_apply",
    plan,
    result.status === "approval-stale"
      ? verdictOf(
          approvalGate({
            // The upstream plan names no approval as a stale one; the person sees it as required.
            stale: parsed.approvedPlan !== undefined,
            ids: { planId: plan.planId },
            lines: [...changeLines(plan), approveLine(plan)],
            data: mattData(plan),
          }),
        )
      : {
          outcome: "completed",
          reason: "matt_skills_installed",
          blockers: [],
          lines: changeLines(plan),
        },
  );
}

function verdictOf(refusal: Refusal): Verdict {
  return {
    outcome: refusal.outcome,
    reason: refusal.reason,
    blockers: refusal.blockers ?? [],
    lines: refusal.lines,
  };
}

function mattData(plan: MattPlan) {
  return { commit: plan.commit, planId: plan.planId, targets: plan.targets, changes: plan.changes };
}

function changeLines(plan: MattPlan): string[] {
  return [
    `Matt skills at upstream commit ${plan.commit}.`,
    ...plan.changes.map((one) => `  ${one.kind} ${one.path}`),
  ];
}

function approveLine(plan: MattPlan): string {
  return `Approve with: operator install matt apply ${plan.targets.map(targetFlag).join(" ")} --commit ${plan.commit} --approved-plan ${plan.planId}`;
}

/**
 * Reports one Matt plan. A copy that differs from its recorded version refuses before the
 * verdict, so nothing is written over a local edit. The Matt reports name their operation
 * before their blockers.
 */
function reportMatt(
  parsed: ParsedArguments,
  operation: MattOperation,
  plan: MattPlan,
  verdict: Verdict,
): void {
  if (plan.conflicts.length > 0) {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "skill_copy_conflict",
        operation,
        blockers: plan.conflicts.map((one) => ({ reason: "skill_copy_modified", ...one })),
        data: { commit: plan.commit, planId: plan.planId, changes: plan.changes },
      },
      lines: [
        "Matt skill copies differ from their recorded versions. Nothing was written.",
        ...plan.conflicts.flatMap((one) => one.paths.map((path) => `  ${path}`)),
      ],
    });
    return;
  }
  report({
    json: parsed.json,
    result: {
      outcome: verdict.outcome,
      reason: verdict.reason,
      operation,
      blockers: verdict.blockers,
      data: mattData(plan),
    },
    lines: verdict.lines,
  });
}

export async function runInstall(parsed: ParsedArguments): Promise<void> {
  const result = await SkillInstall.run({
    projectRoot: process.cwd(),
    targets: parsed.targets,
  });

  if (result.conflicts.length > 0) {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "skill_copy_conflict",
        blockers: result.conflicts.map((conflict) => ({
          reason: "skill_copy_modified" as const,
          skill: conflict.skill,
          target: conflict.target,
          paths: conflict.paths,
        })),
        operation: "install",
      },
      lines: [
        "No skill was installed. These copies differ from this Operator release:",
        ...result.conflicts.flatMap((conflict) => conflict.paths.map((path) => `  ${path}`)),
        "Restore or remove each copy, then install again.",
      ],
    });
    return;
  }

  const installed = result.installed.length > 0;
  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: installed ? "skills_installed" : "skills_already_installed",
      blockers: [],
      operation: "install",
      data: { installed: result.installed, adopted: result.adopted },
    },
    lines: installed
      ? ["Installed the Operator skills:", ...result.installed.map((one) => `  ${one.path}`)]
      : ["Every Operator skill copy already matches this release. Nothing was written."],
  });
}
