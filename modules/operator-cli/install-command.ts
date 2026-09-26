import { SkillInstall } from "../skill-install/main.ts";
import type { ParsedArguments } from "./arguments.ts";
import { reportMissingTarget } from "./missing-target.ts";
import { report } from "./result.ts";

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
