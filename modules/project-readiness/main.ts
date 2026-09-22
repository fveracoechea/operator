import { type Check, passedCheck, staticChecks, unmetCheck } from "./checks.ts";
import { appendRun, readEvidence, type Run, standingObservations } from "./evidence.ts";
import { fingerprints } from "./fingerprints.ts";
import {
  type LiveClaim,
  liveChecks,
  LIVE_PLAN_REVISION,
  probeCleanup,
  probeCredentials,
  PROBE_FIXTURE_CREDENTIAL,
  PROBE_FIXTURE_MISSING,
  probeProviderUse,
  probeTemporaryResources,
} from "./live.ts";
import { type Observation, type Overrides, observeProject, type Target } from "./observe.ts";
import { readLaunchSnapshot } from "./snapshot.ts";

type Request = { projectRoot: string; targets: Target[]; overrides: Overrides };

const PROBE_NEXT_ACTION = "Run `operator setup probe plan`, then apply the approved probe.";

const EVERY_CLAIM: LiveClaim[] = ["readiness", "release"];

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

  const standing =
    read.state === "read" ? standingObservations(read.evidence) : new Map<string, never>();

  return {
    unreadable: null,
    checks: liveChecks.map((declared) => {
      const record = standing.get(declared.name);
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

      const { observation, run } = record;
      if (observation.state === "failed" || observation.state === "skipped") {
        const skipped = observation.state === "skipped";
        return unmetCheck(
          declared.name,
          null,
          // A skipped check proves nothing, so it holds its claims back exactly like a failure.
          skipped ? "unverified" : "failed",
          {
            reason: skipped ? "live_check_skipped" : "live_check_failed",
            detail: `${declared.summary} Probe ${run.probeId} ${skipped ? "skipped" : "failed"} it: ${observation.detail}`,
            nextAction: PROBE_NEXT_ACTION,
          },
          "live",
        );
      }

      const changed = declared.inputs.filter(
        (input) => observation.inputs[input] !== inputs[input],
      );
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
        `${declared.summary} Proven by probe ${run.probeId} on ${observation.finishedAt}.`,
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

/**
 * What each claim may say right now.
 * A static check feeds both claims, because a missing tool holds back a release as surely as a
 * readiness answer. A live check feeds only the claims it declares.
 */
function claimStates(checks: Check[]): Record<LiveClaim, "proven" | "blocked" | "unverified"> {
  const declared = new Map(liveChecks.map((one) => [one.name, one.claims]));

  function stateOf(claim: LiveClaim) {
    const feeding = checks.filter((one) => (declared.get(one.name) ?? EVERY_CLAIM).includes(claim));
    return reportState(feeding) === "ready"
      ? ("proven" as const)
      : feeding.some((one) => one.state === "failed")
        ? ("blocked" as const)
        : ("unverified" as const);
  }

  return { readiness: stateOf("readiness"), release: stateOf("release") };
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

function fixtureOf(observation: Observation) {
  return observation.configuration.probe?.githubFixture ?? null;
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
    fixture: fixtureOf(observation),
    release: {
      version: observation.release.version,
      identity: observation.release.identity,
      lock: { name: observation.release.lock.name, state: observation.release.lock.state },
    },
    versions: Object.fromEntries(
      observation.environment.tools.map((tool) => [tool.tool, tool.version ?? "missing"]),
    ),
    checks,
    claims: claimStates(checks),
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

type Report = Awaited<ReturnType<typeof buildReport>>;

/**
 * True when a check the probe cannot fix has failed.
 * A failed live check is the reason to run a probe again, so only a failing static check, or
 * evidence that cannot be read, holds a probe back.
 */
function staticallyBlocked(report: Report): boolean {
  return report.blockers.some((one) => one.kind === "static" || one.name === "readiness-evidence");
}

function expectedCosts(report: Report): string[] {
  const prompts = liveChecks.reduce(
    (total, one) => ({
      operator: total.operator + one.prompts.operator,
      crew: total.crew + one.prompts.crew,
    }),
    { operator: 0, crew: 0 },
  );

  function hostLine(role: "operator" | "crew"): string {
    const agent = report.selection[role];
    const name = role === "operator" ? "Operator" : "Crew";
    return `${name} host ${agent.host ?? "none named"} with model ${agent.model ?? "the host default"}: ${prompts[role]} synthetic prompts.`;
  }

  return [
    hostLine("operator"),
    hostLine("crew"),
    report.fixture === null
      ? "No probe fixture is configured, so the probe makes no GitHub call."
      : `GitHub fixture ${report.fixture.repository}#${report.fixture.issue}: one comment written, one issue closed and reopened, and the reads the tracker checks need.`,
    "Operator charges nothing of its own. Each provider bills the tokens its own host spends.",
  ];
}

function probeCredentialList(report: Report): string[] {
  return [
    ...probeCredentials,
    report.fixture === null ? PROBE_FIXTURE_MISSING : PROBE_FIXTURE_CREDENTIAL,
  ];
}

function probeDetails(report: Report) {
  const details = {
    planRevision: LIVE_PLAN_REVISION,
    agents: report.selection,
    fixture: report.fixture,
    providerUse: probeProviderUse,
    credentials: probeCredentialList(report),
    temporaryResources: probeTemporaryResources,
    expectedCosts: expectedCosts(report),
    checks: liveChecks.map((one) => ({
      name: one.name,
      summary: one.summary,
      group: one.group,
      claims: one.claims,
    })),
    cleanup: probeCleanup,
  };

  // The identity covers everything the plan shows, so an approval never survives a changed plan.
  const probeId = new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify({
        targets: report.targets.toSorted(),
        release: report.release.identity,
        ...details,
      }),
    )
    .digest("hex");

  return { probeId, ...details };
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

  /** The live checks this release declares, with what each one proves and what it feeds. */
  liveChecks() {
    return liveChecks;
  },

  /**
   * Shows the hosts, models, provider use, credentials, temporary resources, expected costs, and
   * cleanup a live probe would need, before anything launches.
   */
  async probePlan(request: Request) {
    const report = await buildReport(request);
    if (staticallyBlocked(report)) {
      return { status: "blocked" as const, report };
    }

    return { status: "ready" as const, report, plan: probeDetails(report) };
  },

  /** Refuses to launch a live probe without an approval that matches the shown plan. */
  async probe(request: Request & { approvedProbeId: string | undefined }) {
    const report = await buildReport(request);
    if (staticallyBlocked(report)) {
      return { status: "blocked" as const, report };
    }

    const plan = probeDetails(report);
    if (request.approvedProbeId === undefined) {
      return { status: "approval-required" as const, report, plan };
    }
    if (request.approvedProbeId !== plan.probeId) {
      return { status: "approval-stale" as const, report, plan };
    }

    return { status: "approved" as const, report, plan };
  },

  /**
   * Records one probe attempt and answers with the readiness that follows it.
   * Attempts are appended, so a failed attempt stays readable after a later one replaces what
   * it proved. This is the only write to the recorded evidence.
   */
  async record(request: Request & { run: Run }) {
    await appendRun(request.projectRoot, request.run);
    return buildReport(request);
  },
};
