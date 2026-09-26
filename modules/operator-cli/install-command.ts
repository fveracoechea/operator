import { SkillInstall } from "../skill-install/main.ts";
import { type ParsedArguments, targetFlag } from "./arguments.ts";
import { reportMissingTarget } from "./missing-target.ts";
import { type Handled, report } from "./result.ts";

export async function runMattSkills(words: string[], parsed: ParsedArguments): Promise<Handled> {
  if (words.length !== 1 || (words[0] !== "plan" && words[0] !== "apply"))
    return "invalid-arguments";
  const applying = words[0] === "apply";
  const commit = parsed.crew.baseCommit;
  if (
    (applying && (commit === undefined || !/^[a-f0-9]{40}$/.test(commit))) ||
    (!applying && (commit !== undefined || parsed.approvedPlan !== undefined))
  ) {
    return "invalid-arguments";
  }
  if (parsed.targets.length === 0) {
    reportMissingTarget(parsed, applying ? "install_matt_apply" : "install_matt_plan");
    return "reported";
  }
  try {
    const result = applying
      ? await SkillInstall.mattApply({
          projectRoot: process.cwd(),
          targets: parsed.targets,
          commit: commit!,
          approvedPlanId: parsed.approvedPlan,
        })
      : {
          status: "planned" as const,
          plan: await SkillInstall.mattPlan({
            projectRoot: process.cwd(),
            targets: parsed.targets,
          }),
        };
    const { plan } = result;
    const operation = applying ? "install_matt_apply" : "install_matt_plan";
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
      return "reported";
    }
    const stale = result.status === "approval-stale";
    report({
      json: parsed.json,
      result: {
        outcome: stale ? "missing-condition" : "completed",
        reason: stale
          ? parsed.approvedPlan === undefined
            ? "approval_required"
            : "approval_stale"
          : applying
            ? "matt_skills_installed"
            : "matt_plan_ready",
        operation,
        blockers: stale
          ? [
              {
                reason: parsed.approvedPlan === undefined ? "approval_required" : "approval_stale",
                planId: plan.planId,
              },
            ]
          : [],
        data: {
          commit: plan.commit,
          planId: plan.planId,
          targets: plan.targets,
          changes: plan.changes,
        },
      },
      lines: [
        `Matt skills at upstream commit ${plan.commit}.`,
        ...plan.changes.map((one) => `  ${one.kind} ${one.path}`),
        ...(applying && !stale
          ? []
          : [
              `Approve with: operator install matt apply ${plan.targets.map(targetFlag).join(" ")} --commit ${plan.commit} --approved-plan ${plan.planId}`,
            ]),
      ],
    });
  } catch (error) {
    report({
      json: parsed.json,
      result: {
        outcome: "failed",
        reason: "upstream_unavailable",
        operation: applying ? "install_matt_apply" : "install_matt_plan",
        blockers: [{ reason: "upstream_unavailable", detail: String(error) }],
      },
      lines: [`Matt skills could not be checked: ${String(error)}`],
    });
  }
  return "reported";
}

export async function runInstall(parsed: ParsedArguments): Promise<void> {
  if (parsed.targets.length === 0) {
    reportMissingTarget(parsed, "install");
    return;
  }

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
