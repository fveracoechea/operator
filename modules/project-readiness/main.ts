import { type Check, passedCheck, staticChecks, unmetCheck } from "./checks.ts";
import { readEvidence } from "./evidence.ts";
import { fingerprints } from "./fingerprints.ts";
import { liveChecks, probeCleanup, probeProviderUse, probeTemporaryResources } from "./live.ts";
import { type Observation, type Overrides, observeProject, type Target } from "./observe.ts";
import { readLaunchSnapshot } from "./snapshot.ts";

type Request = { projectRoot: string; targets: Target[]; overrides: Overrides };

const PROBE_NEXT_ACTION = "Run `operator setup probe plan`, then apply the approved probe.";

async function liveCheckResults(
  projectRoot: string,
  inputs: Record<string, string>,
): Promise<{ checks: Check[]; unreadable: Check | null }> {
  const read = await readEvidence(projectRoot);
  if (read.state === "unreadable") {
    return {
      checks: [],
      unreadable: unmetCheck(
        "readiness-evidence",
        null,
        "failed",
        {
          reason: "unreadable_evidence",
          detail: `The recorded readiness evidence cannot be read: ${read.detail}`,
          nextAction: "Decide what the recorded evidence should be, then check again.",
          conflict: true,
        },
        "live",
      ),
    };
  }

  const recorded = read.state === "read" ? read.evidence.checks : [];

  return {
    unreadable: null,
    checks: liveChecks.map((declared) => {
      const record = recorded.find((one) => one.name === declared.name);
      if (record === undefined) {
        return unmetCheck(
          declared.name,
          null,
          "unverified",
          {
            reason: "live_check_missing",
            detail: `${declared.summary} No live probe has proven this.`,
            nextAction: PROBE_NEXT_ACTION,
          },
          "live",
        );
      }

      if (record.state === "failed") {
        return unmetCheck(
          declared.name,
          null,
          "failed",
          {
            reason: "live_check_failed",
            detail: `${declared.summary} The last live probe failed: ${record.detail}`,
            nextAction: PROBE_NEXT_ACTION,
          },
          "live",
        );
      }

      const changed = declared.inputs.filter((input) => record.inputs[input] !== inputs[input]);
      if (changed.length > 0) {
        return unmetCheck(
          declared.name,
          null,
          "stale",
          {
            reason: "evidence_stale",
            detail: `${declared.summary} Its evidence was proven against different inputs: ${changed.join(", ")}.`,
            nextAction: PROBE_NEXT_ACTION,
          },
          "live",
        );
      }

      return passedCheck(
        declared.name,
        null,
        `${declared.summary} Proven by probe ${record.probeId} on ${record.observedAt}.`,
        "live",
      );
    }),
  };
}

function reportState(checks: Check[]): "ready" | "blocked" | "unverified" {
  if (checks.some((one) => one.state === "failed")) {
    return "blocked";
  }
  if (checks.some((one) => one.state !== "passed")) {
    return "unverified";
  }

  return "ready";
}

function selectionSummary(observation: Observation) {
  function role(name: "operator" | "crew") {
    return {
      host: observation.selection[name].host.value,
      hostSource: observation.selection[name].host.source,
      model: observation.selection[name].model.value,
      modelSource: observation.selection[name].model.source,
    };
  }

  return { operator: role("operator"), crew: role("crew") };
}

async function buildReport(request: Request) {
  const observation = await observeProject(request);
  const inputs = fingerprints(observation);
  const live = await liveCheckResults(request.projectRoot, inputs);
  const checks = [
    ...staticChecks(observation),
    ...(live.unreadable ? [live.unreadable] : []),
    ...live.checks,
  ];

  return {
    state: reportState(checks),
    // Both selected targets share one completion boundary, so a missing copy leaves it incomplete.
    configured:
      observation.plan.changes.length === 0 &&
      observation.plan.conflicts.length === 0 &&
      observation.skills.missing.length === 0 &&
      observation.skills.conflicts.length === 0,
    platform: observation.environment.platform,
    architecture: observation.environment.architecture,
    targets: observation.targets,
    selection: selectionSummary(observation),
    release: {
      version: observation.release.version,
      identity: observation.release.identity,
      lock: { name: observation.release.lock.name, state: observation.release.lock.state },
    },
    checks,
    blockers: checks.filter((one) => one.state === "failed"),
    unproven: checks.filter((one) => one.state === "unverified" || one.state === "stale"),
    nextActions: [
      ...new Set(
        checks.flatMap((one) =>
          one.state === "passed" || one.nextAction === null ? [] : [one.nextAction],
        ),
      ),
    ],
    inputs,
    // A changed selection reaches new launches only. It never changes a running agent.
    appliesTo: "new-launches" as const,
  };
}

function probeIdentity(report: Awaited<ReturnType<typeof buildReport>>): string {
  return new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify({
        targets: report.targets.toSorted(),
        selection: report.selection,
        release: report.release.identity,
        checks: liveChecks.map((one) => one.name),
        temporaryResources: probeTemporaryResources,
      }),
    )
    .digest("hex");
}

function probeDetails(report: Awaited<ReturnType<typeof buildReport>>) {
  return {
    probeId: probeIdentity(report),
    agents: report.selection,
    providerUse: probeProviderUse,
    temporaryResources: probeTemporaryResources,
    checks: liveChecks.map((one) => ({ name: one.name, summary: one.summary })),
    cleanup: probeCleanup,
  };
}

export const ProjectReadiness = {
  /**
   * Reads the launch inputs one attempt fixes: effective selection, release, lock data, and
   * skills. A launch records this, and recovery compares its record against a later reading.
   */
  async snapshot(request: { projectRoot: string; overrides: Overrides }) {
    return readLaunchSnapshot(request);
  },

  /**
   * Answers whether this exact configuration is ready. Static checks observe the machine and the
   * project on every run. Live capabilities are read from recorded evidence. Writes nothing.
   */
  async check(request: Request) {
    return buildReport(request);
  },

  /** Shows the hosts, models, provider use, and temporary resources a live probe would use. */
  async probePlan(request: Request) {
    const report = await buildReport(request);
    if (report.state === "blocked") {
      return { status: "blocked" as const, report: report };
    }

    return { status: "ready" as const, report: report, plan: probeDetails(report) };
  },

  /** Refuses to launch a live probe without an approval that matches the shown plan. */
  async probe(request: Request & { approvedProbeId: string | undefined }) {
    const report = await buildReport(request);
    if (report.state === "blocked") {
      return { status: "blocked" as const, report: report };
    }

    const plan = probeDetails(report);
    if (request.approvedProbeId === undefined) {
      return { status: "approval-required" as const, report: report, plan };
    }
    if (request.approvedProbeId !== plan.probeId) {
      return { status: "approval-stale" as const, report: report, plan };
    }

    // The approved live matrix is not part of this release, so the configuration stays unverified.
    return { status: "unavailable" as const, report: report, plan };
  },
};
