import { ProjectReadiness } from "../project-readiness/main.ts";
import { type ParsedArguments, targetFlag } from "./arguments.ts";
import { reportMissingTarget } from "./missing-target.ts";
import { blockerData, reportLines } from "./readiness-command.ts";
import { report } from "./result.ts";

type Blocked = { report: Awaited<ReturnType<typeof ProjectReadiness.check>> };
type Planned = Blocked & {
  plan: NonNullable<Awaited<ReturnType<typeof ProjectReadiness.probePlan>>["plan"]>;
};

function reportBlocked(
  parsed: ParsedArguments,
  result: Blocked,
  operation: "setup_probe_plan" | "setup_probe_apply",
): void {
  report({
    json: parsed.json,
    result: {
      outcome: result.report.blockers.some((blocker) => blocker.conflict)
        ? "conflict"
        : "missing-condition",
      reason: "probe_blocked",
      blockers: result.report.blockers.map((check) => blockerData(check, "readiness_blocked")),
      operation,
      data: result.report,
    },
    lines: [
      "A live probe needs a project whose static checks pass. Nothing was launched.",
      "",
      ...reportLines(result.report),
    ],
  });
}

function planLines(result: Planned): string[] {
  return [
    `Operator live probe plan ${result.plan.probeId}`,
    `Targets: ${result.report.targets.join(", ")}`,
    "",
    "Agents:",
    `  Operator: ${result.plan.agents.operator.host} (${result.plan.agents.operator.hostSource}), model ${result.plan.agents.operator.model ?? "the host default"}`,
    `  Crew: ${result.plan.agents.crew.host} (${result.plan.agents.crew.hostSource}), model ${result.plan.agents.crew.model ?? "the host default"}`,
    "",
    "Provider use:",
    ...result.plan.providerUse.map((line) => `  ${line}`),
    "",
    "Temporary resources:",
    ...result.plan.temporaryResources.map((line) => `  ${line}`),
    "",
    "Checks:",
    ...result.plan.checks.flatMap((check) => [`  ${check.name}`, `    ${check.summary}`]),
    "",
    result.plan.cleanup,
  ];
}

/** Repeats the request that produced this plan, so the approval names the same selection. */
function approvalCommand(result: Planned): string {
  const roles = [
    ["operator", result.plan.agents.operator],
    ["crew", result.plan.agents.crew],
  ] as const;
  const overrides = roles.flatMap(([role, agent]) => [
    ...(agent.hostSource === "session-override" ? [`--${role}-host ${agent.host}`] : []),
    ...(agent.modelSource === "session-override" ? [`--${role}-model ${agent.model}`] : []),
  ]);

  return [
    "operator setup probe apply",
    ...result.report.targets.map(targetFlag),
    ...overrides,
    `--approved-probe ${result.plan.probeId}`,
  ].join(" ");
}

function probeData(result: Planned) {
  return { ...result.plan, readiness: result.report };
}

export async function runProbePlan(parsed: ParsedArguments): Promise<void> {
  if (parsed.targets.length === 0) {
    reportMissingTarget(parsed, "setup_probe_plan");
    return;
  }

  const result = await ProjectReadiness.probePlan({
    projectRoot: process.cwd(),
    targets: parsed.targets,
    overrides: parsed.overrides,
  });

  if (result.status === "blocked") {
    reportBlocked(parsed, result, "setup_probe_plan");
    return;
  }

  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "probe_plan_ready",
      blockers: [],
      operation: "setup_probe_plan",
      data: probeData(result),
    },
    lines: [...planLines(result), "", `Approve with: ${approvalCommand(result)}`],
  });
}

export async function runProbeApply(parsed: ParsedArguments): Promise<void> {
  if (parsed.targets.length === 0) {
    reportMissingTarget(parsed, "setup_probe_apply");
    return;
  }

  const result = await ProjectReadiness.probe({
    projectRoot: process.cwd(),
    targets: parsed.targets,
    overrides: parsed.overrides,
    approvedProbeId: parsed.approvedProbe,
  });

  if (result.status === "blocked") {
    reportBlocked(parsed, result, "setup_probe_apply");
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
            currentProbeId: result.plan.probeId,
            approvedProbeId: parsed.approvedProbe ?? null,
          },
        ],
        operation: "setup_probe_apply",
        data: probeData(result),
      },
      lines: [
        stale
          ? "The approved probe no longer matches this project or this selection. Nothing was launched."
          : "A live probe needs its own approval. Nothing was launched.",
        "",
        ...planLines(result),
        "",
        `Approve with: ${approvalCommand(result)}`,
      ],
    });
    return;
  }

  report({
    json: parsed.json,
    result: {
      outcome: "missing-condition",
      reason: "live_probe_unavailable",
      blockers: [
        {
          reason: "live_probe_unavailable",
          detail:
            "This Operator release runs no live probe, so the configuration stays unverified.",
        },
      ],
      operation: "setup_probe_apply",
      data: probeData(result),
    },
    lines: [
      "The probe is approved, and this Operator release runs no live check. Nothing was launched.",
      "The configuration stays unverified.",
    ],
  });
}
