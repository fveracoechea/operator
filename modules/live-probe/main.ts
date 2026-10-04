import { ContentIdentity } from "../content-identity/main.ts";
import { type Host, LIFECYCLE_CHECKS, type Lifecycle } from "./agents.ts";
import type { Target } from "./scratch.ts";
import { runLifecycle } from "./lifecycle.ts";
import { failed, passed, passedAll, type Staged, skipRest } from "./stage.ts";
import { TRACKER_CHECKS, runTrackerChecks } from "./tracker.ts";
import { GithubTracker } from "../github-tracker/main.ts";
import {
  beginRun,
  cancelRuns,
  type CleanupEvent,
  type CleanupFacts,
  type CleanupState,
  decideCleanup,
  finishRun,
  type Fixture,
  inspectRuns,
  intendWrite,
} from "./recovery.ts";

/** The bounded window one agent answer is waited for. A window that runs out fails the check. */
const DEFAULT_OBSERVATION_MS = 120_000;

/** Every check this release can actually run, in the order their evidence allows. */
const SUPPORTED = [...LIFECYCLE_CHECKS, ...TRACKER_CHECKS, "provider-compatibility"];

type RunRequest = {
  projectRoot: string;
  probeId: string;
  approvedProbeId: string;
  planRevision: number;
  targets: string[];
  operator: { host: Host | null; model: string | null };
  crew: { host: Host | null; model: string | null };
  fixture: Fixture | null;
  inputs: Record<string, string>;
  versions: Record<string, string>;
  /** The names readiness declares. A name this release cannot run is recorded as skipped. */
  checks: string[];
};

/**
 * The window one bounded read waits in.
 * `OPERATOR_PROBE_OBSERVATION_MS` shortens it for a deterministic run. A value that is not a
 * positive whole number stops the probe rather than quietly restoring the default.
 */
function observationMs(): number {
  const stated = process.env.OPERATOR_PROBE_OBSERVATION_MS;
  if (stated === undefined) {
    return DEFAULT_OBSERVATION_MS;
  }

  const milliseconds = Number(stated);
  if (!Number.isInteger(milliseconds) || milliseconds <= 0) {
    throw new Error(
      `OPERATOR_PROBE_OBSERVATION_MS must be a positive whole number of milliseconds, and it is ${stated}.`,
    );
  }

  return milliseconds;
}

/**
 * Proves the selected models answered through their own provider.
 * Every launched host sent its prompts to its provider, so the hosts that answered are the
 * evidence. A host that never answered leaves this unproven rather than assumed.
 */
function providerCompatibility(request: RunRequest, staged: Staged[]): Staged {
  const detail = `Operator host ${request.operator.host ?? "none named"} with model ${
    request.operator.model ?? "the host default"
  } and Crew host ${request.crew.host ?? "none named"} with model ${
    request.crew.model ?? "the host default"
  }`;

  return passedAll(staged, ["instruction-and-skill-loading", "review-sub-agents"])
    ? passed("provider-compatibility", `${detail} both answered through their own provider.`, {
        outputs: [`operator ${request.operator.host}`, `crew ${request.crew.host}`],
      })
    : failed("provider-compatibility", `${detail} did not both answer through their own provider.`);
}

/** The installation targets this release knows how to give a synthetic checkout. */
function isTarget(name: string): name is Target {
  return name === "opencode" || name === "claude-code";
}

/**
 * Launches the two synthetic hosts and runs every lifecycle check.
 * With no host named for both roles, nothing is launched and every lifecycle check is skipped.
 */
async function lifecycleStaged(
  request: RunRequest,
  runId: string,
): Promise<{ staged: Staged[]; resources: string[] }> {
  if (request.operator.host === null || request.crew.host === null) {
    const staged: Staged[] = [];
    skipRest(staged, LIFECYCLE_CHECKS, "No host is named for both roles, so nothing was launched.");
    return { staged, resources: [] };
  }
  const lifecycle: Lifecycle = {
    runId,
    probeId: request.probeId,
    projectRoot: request.projectRoot,
    targets: request.targets.filter(isTarget),
    operator: { host: request.operator.host, model: request.operator.model },
    crew: { host: request.crew.host, model: request.crew.model },
    observationMs: observationMs(),
  };
  return runLifecycle(lifecycle);
}

/** One durable observation for each declared check, in the order the checks ran. */
function observationsOf(staged: Staged[], request: RunRequest, startedAt: string) {
  // Checks run one after another, so a check ran between the record before it and its own.
  let opened = startedAt;
  return staged
    .map((one) => {
      const observation = {
        name: one.name,
        state: one.state,
        detail: one.detail,
        startedAt: opened,
        finishedAt: one.recordedAt,
        inputs: request.inputs,
        versions: request.versions,
        outputs: one.outputs,
        evidence: one.evidence,
        cleanup: one.cleanup,
      };
      opened = one.recordedAt;
      return observation;
    })
    .filter((one) => request.checks.includes(one.name));
}

export const LiveProbe = {
  /** The checks this release can run. A declared name outside this list is recorded as skipped. */
  supportedChecks(): string[] {
    return SUPPORTED;
  },

  async inspect(projectRoot: string) {
    return inspectRuns(projectRoot);
  },

  async finish(projectRoot: string, runId: string) {
    return finishRun(projectRoot, runId);
  },

  /** The probe cleanup machine that `removeResources` runs. It reads no Herdr, Git, or file. */
  decideCleanup<Event extends CleanupEvent>(
    state: CleanupState,
    event: Event,
    facts: CleanupFacts[Event],
  ) {
    return decideCleanup(state, event, facts);
  },

  /**
   * Runs the approved live checks and answers with one durable observation for each.
   * It launches only its own synthetic agents, writes only inside its own scratch repository and
   * the configured fixture, and never reaches the project working tree, a project issue, an
   * Operative worktree, a remote, or a release.
   */
  async run(request: RunRequest) {
    const startedAt = new Date().toISOString();
    const runId = crypto.randomUUID();
    const staged: Staged[] = [];
    const resources: string[] = [];

    const lifecycleSelected = request.checks.some(
      (name) => LIFECYCLE_CHECKS.includes(name) || name === "provider-compatibility",
    );
    const trackerSelected = request.checks.some((name) => TRACKER_CHECKS.includes(name));
    const fixtureRead =
      !trackerSelected || request.fixture === null
        ? null
        : await GithubTracker.readIssue(request.fixture);
    if (fixtureRead !== null && fixtureRead.status !== "found") {
      throw new Error(
        "The probe fixture state cannot be read before the run. Nothing was launched.",
      );
    }
    await beginRun(request.projectRoot, {
      runId,
      probeId: request.probeId,
      fixture: request.fixture,
      fixtureState: fixtureRead?.status === "found" ? fixtureRead.value.state : null,
      writes: [],
    });

    if (lifecycleSelected) {
      const lifecycle = await lifecycleStaged(request, runId);
      staged.push(...lifecycle.staged);
      resources.push(...lifecycle.resources);
    }

    let trackerFailed = false;
    if (trackerSelected) {
      const tracker = await runTrackerChecks({
        fixture: request.fixture,
        probeId: request.probeId,
        runId,
        beforeWrite: async (write) => intendWrite(request.projectRoot, runId, write),
      });
      staged.push(...tracker.staged);
      resources.push(...tracker.resources);
      trackerFailed = tracker.staged.some((one) => one.state === "failed");
    }
    if (lifecycleSelected) staged.push(providerCompatibility(request, staged));
    skipRest(
      staged,
      request.checks,
      "This Operator release has no routine for this check, so nothing proved it.",
    );

    const finishedAt = new Date().toISOString();
    const observations = observationsOf(staged, request, startedAt);

    return {
      runId,
      trackerFailed,
      attempt: {
        probeId: request.probeId,
        planRevision: request.planRevision,
        approvedProbeId: request.approvedProbeId,
        startedAt,
        finishedAt,
        targets: request.targets,
        versions: request.versions,
        observations,
        cleanup: {
          // The scratch repository and the fixture evidence outlive the run on purpose.
          state: resources.length === 0 ? ("not-applicable" as const) : ("retained" as const),
          detail:
            resources.length === 0
              ? "This probe created no scratch resource. Fixture changes stay on the fixture."
              : `The probe resources stay until \`operator setup probe cleanup\` is approved. Identity ${ContentIdentity.of(resources)}.`,
          resources,
        },
      },
    };
  },

  /**
   * Removes the scratch repositories earlier runs left behind, under an approval that names them.
   * It touches only the one ignored directory probes write in, so disposing of a temporary
   * resource carries no authority over an Operative worktree, a branch, a merge, or a release.
   * The recorded observations stay, so every failed attempt survives its resources.
   */
  async removeResources(request: { projectRoot: string; approvedCleanupId: string | undefined }) {
    return cancelRuns(await inspectRuns(request.projectRoot), request.approvedCleanupId);
  },
};
