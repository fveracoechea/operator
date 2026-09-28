// Bun has no atomic file rename or recursive directory removal API.
import { mkdir, rename, rm } from "node:fs/promises";
import { ContentIdentity } from "../content-identity/main.ts";
import { GithubTracker } from "../github-tracker/main.ts";
import { HerdrControl } from "../herdr-control/main.ts";
import { TrackerUpdate } from "../tracker-update/main.ts";
import { z } from "zod";
import { isIdleShell, probeAgentName } from "./agents.ts";
import { commitProbeWork, PROBE_DIRECTORY, removeScratch, scratchDirectories } from "./scratch.ts";
import type { Fixture } from "./tracker.ts";

type Write = {
  operationId: string;
  step: "resolution" | "map_amendment" | "completion" | "reopen";
  issue: number;
  expectedActor: string;
  contentIdentity: string | null;
  eventCount?: number | null;
  outcome?: "succeeded" | "failed" | "uncertain" | "unavailable";
};
type Run = {
  runId: string;
  probeId: string;
  fixture: Fixture | null;
  fixtureState: string | null;
  writes: Write[];
};
const writeSchema = z.object({
  operationId: z.uuid(),
  step: z.enum(["resolution", "map_amendment", "completion", "reopen"]),
  issue: z.number(),
  expectedActor: z.string(),
  contentIdentity: z.string().nullable(),
  eventCount: z.number().nullable().optional(),
  outcome: z.enum(["succeeded", "failed", "uncertain", "unavailable"]).optional(),
});
const runSchema = z.object({
  runId: z.uuid(),
  probeId: z.string(),
  fixture: z
    .object({ repository: z.string(), issue: z.number(), mapIssue: z.number().optional() })
    .nullable(),
  fixtureState: z.string().nullable(),
  writes: z.array(writeSchema),
});
type Resource = {
  directory: string;
  runId: string;
  agents: string[];
  worktree: "absent" | "present" | "unknown";
  workspaceId: string | null;
  fixture: string;
  detail: string | null;
  resourceDetail: string | null;
  fixtureDetail: string | null;
};

function root(projectRoot: string): string {
  return `${projectRoot}/${PROBE_DIRECTORY}`;
}

function journal(projectRoot: string, runId: string): string {
  return `${root(projectRoot)}/${runId}/run.json`;
}

function names(projectRoot: string, runId: string): string[] {
  const prefix = `operator-probe-${runId.replaceAll("-", "").slice(0, 8)}`;
  return [
    probeAgentName(projectRoot, runId, "operator"),
    probeAgentName(projectRoot, runId, "crew"),
    `${prefix}-operator`,
    `${prefix}-crew`,
  ];
}

async function readRun(projectRoot: string, runId: string): Promise<Run | null> {
  const file = Bun.file(journal(projectRoot, runId));
  if (!(await file.exists())) return null;
  const parsed = runSchema.safeParse(await file.json());
  if (!parsed.success || parsed.data.runId !== runId) {
    throw new Error(`The probe run record ${journal(projectRoot, runId)} cannot be read.`);
  }
  return parsed.data;
}

/** Writes the identity before the scratch repository, Herdr, or tracker can change anything. */
export async function beginRun(projectRoot: string, run: Run): Promise<void> {
  const path = journal(projectRoot, run.runId);
  await mkdir(`${root(projectRoot)}/${run.runId}`, { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  // A lifecycle-only run has no fixture effect to reconcile, even if one is configured.
  const stored =
    run.fixtureState === null && run.writes.length === 0 ? { ...run, fixture: null } : run;
  await Bun.write(temporary, `${JSON.stringify(stored)}\n`);
  await rename(temporary, path);
}

/** Fixes a tracker write's marker and expected actor before the external request is sent. */
export async function intendWrite(projectRoot: string, runId: string, write: Write): Promise<void> {
  const run = await readRun(projectRoot, runId);
  if (run === null) throw new Error("The probe run record is missing before a tracker write.");
  if (run.fixture === null || run.fixtureState === null) {
    throw new Error("A probe fixture write requires a recorded fixture and baseline.");
  }
  const path = journal(projectRoot, runId);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const previous = run.writes.find((one) => one.operationId === write.operationId);
  if (
    previous !== undefined &&
    (previous.outcome !== undefined ||
      write.outcome === undefined ||
      previous.step !== write.step ||
      previous.issue !== write.issue ||
      previous.expectedActor !== write.expectedActor ||
      previous.contentIdentity !== write.contentIdentity ||
      previous.eventCount !== write.eventCount)
  )
    throw new Error("A probe fixture write cannot change identity or be sent twice.");
  if (previous === undefined && write.outcome !== undefined) {
    throw new Error("A probe fixture write needs an intent before its outcome.");
  }
  const writes =
    previous === undefined
      ? [...run.writes, write]
      : run.writes.map((one) => (one.operationId === write.operationId ? write : one));
  await Bun.write(temporary, `${JSON.stringify({ ...run, writes })}\n`);
  await rename(temporary, path);
}

/** Old runs have no journal. Prove the repository's own committed probe identity first. */
async function ownsLegacyRepository(
  directory: string,
  runId: string,
  hasWorktree: boolean,
): Promise<boolean> {
  const repo = `${directory}/repo`;
  try {
    const [top, readme, email, message] = await Promise.all([
      Bun.$`git -C ${repo} rev-parse --show-toplevel`.quiet(),
      Bun.$`git -C ${repo} show HEAD:README.md`.quiet(),
      Bun.$`git -C ${repo} log -1 --format=%ae`.quiet(),
      Bun.$`git -C ${repo} log -1 --format=%s`.quiet(),
    ]);
    if (
      top.stdout.toString().trim() !== repo ||
      readme.stdout.toString() !== `# Operator live probe ${runId}\n` ||
      email.stdout.toString().trim() !== "probe@operator.invalid" ||
      message.stdout.toString().trim() !== "probe"
    )
      return false;
    if (!hasWorktree) return true;
    const branch = await Bun.$`git -C ${directory}/worktree symbolic-ref --short HEAD`.quiet();
    return branch.stdout.toString().trim() === `operator-probe/${runId}`;
  } catch {
    return false;
  }
}

export async function finishRun(projectRoot: string, runId: string): Promise<void> {
  await rm(journal(projectRoot, runId));
}

async function inspectWrite(
  fixture: Fixture,
  state: string,
  write: Write,
): Promise<{ status: string; detail: string | null }> {
  if (write.step === "reopen") {
    const history = await GithubTracker.readEvents({
      repository: fixture.repository,
      issue: write.issue,
    });
    const reopened =
      write.eventCount !== null &&
      write.eventCount !== undefined &&
      history.coverage.complete &&
      history.events.slice(write.eventCount).some((one) => one.event === "reopened");
    const proven = reopened && state === "open";
    return {
      status: `reopen ${proven ? "observed" : "uncertain"}`,
      detail: proven
        ? null
        : `The fixture reopen ${write.operationId} for ${fixture.repository}#${write.issue} is not proven. Verify its state and complete event history. Restore the fixture to open only under separate human approval, then inspect cleanup again. Operator will not resend the reopen.`,
    };
  }
  const observed = await TrackerUpdate.observe({
    provider: "github",
    step: write.step,
    target: { repository: fixture.repository, issue: write.issue },
    operationId: write.operationId,
    expectedActor: write.expectedActor,
    contentIdentity: write.contentIdentity,
    resourceId: null,
    sentWrites: 1,
    now: new Date().toISOString(),
  });
  if (observed.kind === "closure") {
    const unsettled =
      (write.outcome === undefined || write.outcome === "uncertain") &&
      !(observed.state === "closed" && observed.stateReason === "completed");
    return {
      status: `closure ${unsettled ? "uncertain" : (observed.state ?? "unknown")}`,
      detail:
        observed.read === "found" && observed.eventCoverage.complete && !unsettled
          ? null
          : `The fixture closure ${write.operationId} cannot be settled from its response and a complete read.`,
    };
  }
  const unique =
    observed.coverage.complete &&
    observed.exactMatches.length <= 1 &&
    observed.editedMatches.length === 0 &&
    observed.actorMismatches.length === 0;
  const matched = unique && observed.exactMatches.length === 1;
  const absent =
    unique &&
    observed.exactMatches.length === 0 &&
    (write.outcome === "failed" || write.outcome === "unavailable");
  return {
    status: `${write.step} ${matched ? "written" : absent ? "absent" : "uncertain"}`,
    detail: !unique
      ? `The fixture write ${write.operationId} cannot be settled from a complete, unique comment scan.`
      : matched || absent
        ? null
        : `The fixture comment ${write.operationId} has no proven outcome. An empty scan does not settle an uncertain write.`,
  };
}

/** Reads intended fixture effects by identity, without sending a second write. */
async function inspectFixture(run: Run): Promise<{ fixture: string; detail: string | null }> {
  if (run.fixture === null) return { fixture: "none", detail: null };
  if (run.fixtureState === null && run.writes.length === 0) {
    return { fixture: "configured, no fixture write", detail: null };
  }
  const read = await GithubTracker.readIssue(run.fixture);
  let fixture = read.status === "found" ? read.value.state : "unknown";
  let detail: string | null =
    fixture === "unknown" || fixture !== run.fixtureState
      ? `The fixture ${run.fixture.repository}#${run.fixture.issue} is ${fixture}, and it was ${run.fixtureState ?? "unknown"} before the run. Inspect it before cleanup.`
      : null;
  for (const write of run.writes) {
    const observed = await inspectWrite(
      run.fixture,
      read.status === "found" ? read.value.state : "unknown",
      write,
    );
    fixture += `, ${observed.status}`;
    if (observed.detail !== null) {
      detail = detail === null ? observed.detail : `${detail} ${observed.detail}`;
    }
  }
  return { fixture, detail };
}

/** A read-only inventory for both status and the approval bound to cleanup. */
export async function inspectRuns(projectRoot: string) {
  const directories = await scratchDirectories(projectRoot);
  const resources: Resource[] = [];
  for (const directory of directories) {
    const runId = directory.slice(root(projectRoot).length + 1);
    const run = await readRun(projectRoot, runId);
    // A crash before Git init has no repository for Herdr to list.
    const worktree = (await Bun.file(`${directory}/repo/.git/HEAD`).exists())
      ? await HerdrControl.findWorktree({
          repoRoot: `${directory}/repo`,
          path: `${directory}/worktree`,
        })
      : ({ status: "absent" } as const);
    const agents: string[] = [];
    let detail = worktree.status === "unknown" ? worktree.detail : null;
    for (const name of names(projectRoot, runId)) {
      const found = await HerdrControl.findAgent({ name });
      if (found.status === "unknown") detail = `${name}: ${found.detail}`;
      if (found.status === "found") {
        if (
          worktree.status !== "found" ||
          worktree.value.workspaceId === null ||
          !found.value.paneId.startsWith(`${worktree.value.workspaceId}:`)
        ) {
          detail = `${name} is not in this probe's worktree workspace.`;
        }
        agents.push(name);
      }
    }
    if (
      run === null &&
      !(await ownsLegacyRepository(directory, runId, worktree.status === "found"))
    ) {
      detail =
        "This scratch repository has no probe journal or committed probe ownership proof. Preserve it for inspection.";
    }
    const fixtureStatus =
      run === null
        ? worktree.status === "absent" && agents.length === 0
          ? { fixture: "recorded", detail: null }
          : { fixture: "unrecorded", detail: null }
        : await inspectFixture(run);
    const resourceDetail = detail;
    detail ??= fixtureStatus.detail;
    resources.push({
      directory,
      runId,
      agents,
      worktree: worktree.status === "found" ? "present" : worktree.status,
      workspaceId: worktree.status === "found" ? worktree.value.workspaceId : null,
      fixture: fixtureStatus.fixture,
      detail,
      resourceDetail,
      fixtureDetail: fixtureStatus.detail,
    });
  }
  return {
    projectRoot,
    directory: root(projectRoot),
    directories,
    resources,
    cleanupId: ContentIdentity.of(resources),
  };
}

/** Refuses an unknown effect or another workspace occupant instead of removing its checkout. */
export async function cancelRuns(inspected: Awaited<ReturnType<typeof inspectRuns>>) {
  for (const resource of inspected.resources) {
    if (resource.resourceDetail !== null)
      return { status: "blocked" as const, ...inspected, detail: resource.resourceDetail };
    if (resource.worktree === "present") {
      if (resource.workspaceId === null)
        return {
          status: "blocked" as const,
          ...inspected,
          detail: "Herdr did not name the probe workspace.",
        };
      const listed = await HerdrControl.listAgents();
      if (listed.status !== "found")
        return {
          status: "blocked" as const,
          ...inspected,
          detail: "Herdr cannot list the workspace agents.",
        };
      const occupants = listed.value.filter(
        (agent) =>
          agent.paneId.startsWith(`${resource.workspaceId}:`) &&
          !resource.agents.includes(agent.name ?? ""),
      );
      if (occupants.length > 0)
        return {
          status: "blocked" as const,
          ...inspected,
          detail: "Another agent occupies the probe workspace.",
        };
    }
  }

  for (const resource of inspected.resources) {
    for (const name of resource.agents) {
      const before = await HerdrControl.findAgent({ name });
      if (before.status !== "found")
        return {
          status: "blocked" as const,
          ...inspected,
          detail: `Herdr cannot identify ${name}'s pane.`,
        };
      const stopped = await HerdrControl.stopAgent({ target: name, keys: ["Escape", "C-c"] });
      const after = await HerdrControl.findAgent({ name });
      if (after.status !== "absent")
        return {
          status: "blocked" as const,
          ...inspected,
          detail: `Herdr still reports ${name}: ${stopped.status}.`,
        };
      const processes = await HerdrControl.readPaneProcesses({ paneId: before.value.paneId });
      if (
        processes.status === "unknown" ||
        (processes.status === "found" &&
          processes.value.foreground.some((one) => !isIdleShell(one, processes.value.shellPid)))
      ) {
        return {
          status: "blocked" as const,
          ...inspected,
          detail: `The pane for ${name} still holds an unknown or live foreground process.`,
        };
      }
    }
    if (resource.worktree === "present" && resource.workspaceId !== null) {
      if ((await commitProbeWork(`${resource.directory}/worktree`)) === null) {
        return {
          status: "blocked" as const,
          ...inspected,
          detail: "The probe checkout cannot be committed before removal.",
        };
      }
      const removed = await HerdrControl.removeWorktree({ workspaceId: resource.workspaceId });
      const after = await HerdrControl.findWorktree({
        repoRoot: `${resource.directory}/repo`,
        path: `${resource.directory}/worktree`,
      });
      if (after.status !== "absent")
        return {
          status: "blocked" as const,
          ...inspected,
          detail: `The probe worktree remains: ${removed.status}.`,
        };
    }
    if (resource.fixtureDetail !== null) {
      // The worktree is gone, but the fixture still needs its write identities for reconciliation.
      await rm(`${resource.directory}/repo`, { recursive: true, force: true });
    } else {
      await removeScratch(resource.directory);
    }
  }
  const remaining = await inspectRuns(inspected.projectRoot);
  if (remaining.resources.length > 0) {
    return { status: "pending-fixture" as const, ...remaining };
  }
  return { status: "removed" as const, ...inspected };
}
