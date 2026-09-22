import { ContentIdentity } from "../content-identity/main.ts";
import { type Host, LIFECYCLE_CHECKS, type Lifecycle, runLifecycle } from "./lifecycle.ts";
import { PROBE_DIRECTORY, removeScratch, scratchDirectories } from "./scratch.ts";
import { failed, passed, passedAll, type Staged, skipRest } from "./stage.ts";
import { type Fixture, TRACKER_CHECKS, runTrackerChecks } from "./tracker.ts";

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

/** What a cleanup would remove, and the identity an approval of it must match. */
async function inspectScratch(projectRoot: string) {
  const directories = await scratchDirectories(projectRoot);
  return {
    directory: `${projectRoot}/${PROBE_DIRECTORY}`,
    directories,
    cleanupId: ContentIdentity.of(directories.map((one) => one.slice(projectRoot.length))),
  };
}

export const LiveProbe = {
  /** The checks this release can run. A declared name outside this list is recorded as skipped. */
  supportedChecks(): string[] {
    return SUPPORTED;
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

    if (request.operator.host === null || request.crew.host === null) {
      skipRest(
        staged,
        LIFECYCLE_CHECKS,
        "No host is named for both roles, so nothing was launched.",
      );
    } else {
      const lifecycle: Lifecycle = {
        runId,
        probeId: request.probeId,
        projectRoot: request.projectRoot,
        operator: { host: request.operator.host, model: request.operator.model },
        crew: { host: request.crew.host, model: request.crew.model },
        observationMs: observationMs(),
      };
      const ran = await runLifecycle(lifecycle);
      staged.push(...ran.staged);
      resources.push(...ran.resources);
    }

    const tracker = await runTrackerChecks({ fixture: request.fixture, probeId: request.probeId });
    staged.push(...tracker.staged);
    resources.push(...tracker.resources);
    staged.push(providerCompatibility(request, staged));
    skipRest(
      staged,
      request.checks,
      "This Operator release has no routine for this check, so nothing proved it.",
    );

    const finishedAt = new Date().toISOString();
    const observations = staged
      .filter((one) => request.checks.includes(one.name))
      .map((one) => ({
        name: one.name,
        state: one.state,
        detail: one.detail,
        startedAt,
        finishedAt,
        inputs: request.inputs,
        versions: request.versions,
        outputs: one.outputs,
        evidence: one.evidence,
        cleanup: one.cleanup,
      }));

    return {
      run: {
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
          state: "retained" as const,
          detail: `The probe resources stay until \`operator setup probe cleanup\` is approved. Identity ${ContentIdentity.of(resources)}.`,
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
    const inspected = await inspectScratch(request.projectRoot);
    if (inspected.directories.length === 0) {
      return { status: "nothing" as const, ...inspected };
    }
    if (request.approvedCleanupId === undefined) {
      return { status: "approval-required" as const, ...inspected };
    }
    if (request.approvedCleanupId !== inspected.cleanupId) {
      return { status: "approval-stale" as const, ...inspected };
    }

    for (const directory of inspected.directories) {
      await removeScratch(directory);
    }

    return { status: "removed" as const, ...inspected };
  },
};
