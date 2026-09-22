import { ProjectReadiness } from "../project-readiness/main.ts";
import type { ParsedArguments } from "./arguments.ts";
import { reportMissingTarget } from "./missing-target.ts";
import { type Reason, report } from "./result.ts";

type Report = Awaited<ReturnType<typeof ProjectReadiness.check>>;
type Check = Report["checks"][number];

// The readiness module names why a check failed; this table is the CLI's promise about those names.
const reasons: Record<string, Reason> = {
  tool_unavailable: "tool_unavailable",
  git_unavailable: "git_unavailable",
  lock_data_missing: "lock_data_missing",
  release_mismatch: "release_mismatch",
  not_configured: "not_configured",
  invalid_configuration: "invalid_configuration",
  operator_directory_tracked: "operator_directory_tracked",
  settings_incomplete: "settings_incomplete",
  skill_copy_modified: "skill_copy_modified",
  skills_missing: "skills_missing",
  instructions_modified: "instructions_modified",
  instructions_missing: "instructions_missing",
  host_unnamed: "host_unnamed",
  host_unavailable: "host_unavailable",
  live_check_missing: "live_check_missing",
  live_check_failed: "live_check_failed",
  live_check_skipped: "live_check_skipped",
  evidence_stale: "evidence_stale",
  unreadable_evidence: "unreadable_evidence",
};

function checkReason(check: Check, fallback: Reason): Reason {
  return (check.reason === null ? undefined : reasons[check.reason]) ?? fallback;
}

export function blockerData(check: Check, fallback: Reason) {
  return {
    reason: checkReason(check, fallback),
    check: check.name,
    target: check.target,
    detail: check.detail,
    nextAction: check.nextAction,
    paths: check.paths,
  };
}

function roleLine(role: string, selected: Report["selection"]["operator"]): string {
  const host =
    selected.host === null
      ? `none named (${selected.hostSource})`
      : `${selected.host} (${selected.hostSource})`;
  const model =
    selected.model === null
      ? `the host default (${selected.modelSource})`
      : `${selected.model} (${selected.modelSource})`;
  return `${role} host: ${host}, model: ${model}`;
}

function checkLines(checks: Check[]): string[] {
  return checks.flatMap((check) => [
    `  ${check.state.padEnd(10)} ${check.name}${check.target === null ? "" : ` (${check.target})`}`,
    `    ${check.detail}`,
    ...(check.nextAction === null ? [] : [`    Next: ${check.nextAction}`]),
  ]);
}

export function reportLines(readiness: Report): string[] {
  return [
    `Operator readiness: ${readiness.state}`,
    `Configured: ${readiness.configured ? "yes" : "no"}`,
    `Observed on ${readiness.platform}/${readiness.architecture} with Operator ${readiness.release.version}`,
    `Targets: ${readiness.targets.join(", ")}`,
    roleLine("Operator", readiness.selection.operator),
    roleLine("Crew", readiness.selection.crew),
    "This selection reaches new launches only. It does not change a running agent.",
    "",
    ...checkLines(readiness.checks),
    ...(readiness.nextActions.length === 0
      ? []
      : ["", "Next actions:", ...readiness.nextActions.map((action) => `  - ${action}`)]),
  ];
}

export async function runReadiness(parsed: ParsedArguments): Promise<void> {
  if (parsed.targets.length === 0) {
    reportMissingTarget(parsed, "setup_readiness");
    return;
  }

  const readiness = await ProjectReadiness.check({
    projectRoot: process.cwd(),
    targets: parsed.targets,
    overrides: parsed.overrides,
  });

  const blocked = readiness.state === "blocked";
  const conflicting = readiness.blockers.some((blocker) => blocker.conflict);

  report({
    json: parsed.json,
    result: {
      outcome:
        readiness.state === "ready"
          ? "completed"
          : blocked && conflicting
            ? "conflict"
            : "missing-condition",
      reason: blocked
        ? "readiness_blocked"
        : readiness.state === "ready"
          ? "readiness_ready"
          : "readiness_unverified",
      blockers: [
        ...readiness.blockers.map((check) => blockerData(check, "readiness_blocked")),
        ...readiness.unproven.map((check) => blockerData(check, "readiness_unverified")),
      ],
      operation: "setup_readiness",
      data: readiness,
    },
    lines: reportLines(readiness),
  });
}
