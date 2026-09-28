import { LiveProbe } from "../live-probe/main.ts";
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

function section(title: string, lines: string[]): string[] {
  return ["", `${title}:`, ...lines.map((line) => `  ${line}`)];
}

function planLines(result: Planned): string[] {
  return [
    "Operator live probe plan",
    `Targets: ${result.report.targets.join(", ")}`,
    ...section("Agents", [
      `Operator: ${result.plan.agents.operator.host} (${result.plan.agents.operator.hostSource}), model ${result.plan.agents.operator.model ?? "the host default"}`,
      `Crew: ${result.plan.agents.crew.host} (${result.plan.agents.crew.hostSource}), model ${result.plan.agents.crew.model ?? "the host default"}`,
    ]),
    ...section("Fixture requirements", result.plan.fixtureRequirements),
    ...section("Provider use", result.plan.providerUse),
    ...section("Credentials required", result.plan.credentials),
    ...section("Temporary resources", result.plan.temporaryResources),
    ...section("Expected costs", result.plan.expectedCosts),
    ...section("Execution", result.plan.execution),
    ...section(
      "Checks",
      result.plan.checks.flatMap((check) => [
        `${check.name} (${check.group}, feeds ${check.claims.join(" and ")})`,
        `  ${check.summary}`,
      ]),
    ),
    ...section("Cleanup", result.plan.cleanup),
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
    ...(result.plan.staleOnly ? ["--stale-only"] : []),
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
    staleOnly: parsed.staleOnly,
  });

  if (result.status === "blocked") {
    reportBlocked(parsed, result, "setup_probe_plan");
    return;
  }
  if (result.status === "nothing-stale") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "probe_nothing_stale",
        blockers: [{ reason: "probe_nothing_stale" }],
        operation: "setup_probe_plan",
        data: result.report,
      },
      lines: [
        "No live check has stale evidence. Use the full probe plan if other checks need proof.",
      ],
    });
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

  const pending = (await LiveProbe.inspect(process.cwd())).resources.filter(
    (one) => one.fixture !== "recorded",
  );
  if (pending.length > 0) {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "probe_incomplete_run",
        blockers: pending.map((one) => ({ reason: "probe_incomplete_run", runId: one.runId })),
        operation: "setup_probe_apply",
        data: { resources: pending },
      },
      lines: [
        "A probe run is incomplete. No new run was started.",
        ...pending.map(
          (one) =>
            `  ${one.runId}: ${one.worktree} worktree, ${one.agents.length} agents, fixture ${one.fixture}`,
        ),
        "Inspect or cancel it with `operator setup probe cleanup`.",
      ],
    });
    return;
  }

  const result = await ProjectReadiness.probe({
    projectRoot: process.cwd(),
    targets: parsed.targets,
    overrides: parsed.overrides,
    staleOnly: parsed.staleOnly,
    approvedProbeId: parsed.approvedProbe,
  });

  if (result.status === "blocked") {
    reportBlocked(parsed, result, "setup_probe_apply");
    return;
  }
  if (result.status === "nothing-stale") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "probe_nothing_stale",
        blockers: [{ reason: "probe_nothing_stale" }],
        operation: "setup_probe_apply",
        data: result.report,
      },
      lines: ["No live check has stale evidence. Nothing was launched."],
    });
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

  // The approval matched the plan, so the record names both and a reader can see the binding.
  const ran = await LiveProbe.run({
    projectRoot: process.cwd(),
    probeId: result.plan.probeId,
    approvedProbeId: parsed.approvedProbe ?? result.plan.probeId,
    planRevision: result.plan.planRevision,
    targets: result.report.targets,
    operator: {
      host: result.plan.agents.operator.host,
      model: result.plan.agents.operator.model,
    },
    crew: { host: result.plan.agents.crew.host, model: result.plan.agents.crew.model },
    fixture: result.plan.fixture,
    inputs: result.report.inputs,
    versions: result.report.versions,
    checks: result.plan.checks.map((check) => check.name),
  });

  const readiness = await ProjectReadiness.record({
    projectRoot: process.cwd(),
    targets: parsed.targets,
    overrides: parsed.overrides,
    attempt: ran.attempt,
  });
  const current = (await LiveProbe.inspect(process.cwd())).resources.find(
    (one) => one.runId === ran.runId,
  );
  if (
    !ran.trackerFailed &&
    current?.worktree === "absent" &&
    current.agents.length === 0 &&
    current.detail === null
  ) {
    await LiveProbe.finish(process.cwd(), ran.runId);
  }

  const unproven = ran.attempt.observations.filter((one) => one.state !== "passed");
  const failures = unproven.filter((one) => one.state === "failed");
  // One decision names the outcome and the reason together, so the two cannot disagree.
  const verdict =
    unproven.length === 0
      ? ({ outcome: "completed", reason: "probe_completed" } as const)
      : failures.length > 0
        ? ({ outcome: "failed", reason: "probe_run_failed" } as const)
        : ({ outcome: "missing-condition", reason: "probe_incomplete" } as const);

  report({
    json: parsed.json,
    result: {
      outcome: verdict.outcome,
      reason: verdict.reason,
      blockers: unproven.map((one) => ({
        reason:
          one.state === "failed" ? ("live_check_failed" as const) : ("live_check_skipped" as const),
        check: one.name,
        detail: one.detail,
      })),
      operation: "setup_probe_apply",
      data: { probeId: result.plan.probeId, attempt: ran.attempt, readiness },
    },
    lines: [
      `The Operator live probe ran ${ran.attempt.observations.length} checks.`,
      "",
      ...ran.attempt.observations.flatMap((one) => [
        `  ${one.state.padEnd(8)} ${one.name}`,
        `    ${one.detail}`,
      ]),
      "",
      `Readiness is now ${readiness.state}. The readiness claim is ${readiness.claims.readiness} and the release claim is ${readiness.claims.release}.`,
      ran.attempt.cleanup.resources.length === 0
        ? "The probe left no temporary resource behind."
        : `The probe left ${ran.attempt.cleanup.resources.length} temporary resources. Remove them with \`operator setup probe cleanup\`.`,
    ],
  });
}

/**
 * Removes the temporary resources earlier probes left behind, under its own approval.
 * Deleting a probe resource carries no authority over an Operative worktree, a merge, or a
 * release, and the recorded observations stay, so every failed attempt survives its resources.
 */
export async function runProbeCleanup(parsed: ParsedArguments): Promise<void> {
  const result = await LiveProbe.removeResources({
    projectRoot: process.cwd(),
    approvedCleanupId: parsed.approvedCleanup,
  });

  if (result.status === "nothing") {
    report({
      json: parsed.json,
      result: {
        outcome: "completed",
        reason: "probe_no_resources",
        blockers: [],
        operation: "setup_probe_cleanup",
        data: result,
      },
      lines: ["The probe holds no temporary resource. Nothing was removed."],
    });
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
            currentCleanupId: result.cleanupId,
            approvedCleanupId: parsed.approvedCleanup ?? null,
          },
        ],
        operation: "setup_probe_cleanup",
        data: result,
      },
      lines: [
        stale
          ? "The approved cleanup no longer names these resources. Nothing was removed."
          : "Removing a probe resource needs its own approval. Nothing was removed.",
        "",
        "These probe resources will be inspected for approved cleanup:",
        ...result.directories.map((one) => `  ${one}`),
        ...result.resources
          .filter((one) => one.fixture !== "recorded")
          .map(
            (one) =>
              `  ${one.runId}: ${one.worktree} worktree, agents ${one.agents.join(", ") || "none"}, fixture ${one.fixture}${one.detail === null ? "" : `, ${one.detail}`}`,
          ),
        "",
        "The recorded observations stay, so every failed attempt is preserved.",
        "An unresolved fixture keeps its journal after its verified agents and worktree are removed.",
        "",
        `Approve with: operator setup probe cleanup --approved-cleanup ${result.cleanupId}`,
      ],
    });
    return;
  }

  if (result.status === "blocked") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "probe_cleanup_blocked",
        blockers: [{ reason: "probe_cleanup_blocked", detail: result.detail }],
        operation: "setup_probe_cleanup",
        data: result,
      },
      lines: [
        `Probe cleanup stopped: ${result.detail}`,
        "Run cleanup again to inspect the remaining resources.",
      ],
    });
    return;
  }

  if (result.status === "pending-fixture") {
    const unresolved = result.resources.filter((one) => one.fixtureDetail !== null);
    const pending = result.resources.filter((one) => one.fixtureDetail === null);
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "probe_fixture_unresolved",
        blockers: result.resources.map((one) => ({
          reason: "probe_fixture_unresolved",
          runId: one.runId,
          detail:
            one.fixtureDetail ??
            "The fixture now verifies. A new cleanup approval is needed to remove its journal.",
        })),
        operation: "setup_probe_cleanup",
        data: result,
      },
      lines: [
        "Approved probe agents and worktrees were checked and removed where safe. A fixture journal remains.",
        ...unresolved.map((one) => `  ${one.runId}: ${one.fixture}. ${one.fixtureDetail}`),
        ...pending.map(
          (one) =>
            `  ${one.runId}: the fixture now verifies, but its journal needs a new cleanup approval.`,
        ),
        "The fixture journal remains. After the fixture is verified or restored under separate human approval, inspect cleanup again for a new approval ID. Operator will not repeat an uncertain fixture write.",
      ],
    });
    return;
  }

  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "probe_resources_removed",
      blockers: [],
      operation: "setup_probe_cleanup",
      data: result,
    },
    lines: [
      "Removed the temporary resources of earlier probes:",
      ...result.directories.map((one) => `  ${one}`),
      "The recorded observations stay, so every failed attempt is preserved.",
    ],
  });
}
