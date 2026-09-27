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
  step: "resolution" | "map_amendment" | "completion";
  issue: number;
  expectedActor: string;
  contentIdentity: string | null;
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
  step: z.enum(["resolution", "map_amendment", "completion"]),
  issue: z.number(),
  expectedActor: z.string(),
  contentIdentity: z.string().nullable(),
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
  await Bun.write(temporary, `${JSON.stringify(run)}\n`);
  await rename(temporary, path);
}

/** Fixes a tracker write's marker and expected actor before the external request is sent. */
export async function intendWrite(projectRoot: string, runId: string, write: Write): Promise<void> {
  const run = await readRun(projectRoot, runId);
  if (run === null) throw new Error("The probe run record is missing before a tracker write.");
  const path = journal(projectRoot, runId);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temporary, `${JSON.stringify({ ...run, writes: [...run.writes, write] })}\n`);
  await rename(temporary, path);
}

export async function finishRun(projectRoot: string, runId: string): Promise<void> {
  await rm(journal(projectRoot, runId));
}

/** Reads intended fixture effects by identity, without sending a second write. */
async function inspectFixture(run: Run): Promise<{ fixture: string; detail: string | null }> {
  if (run.fixture === null) return { fixture: "none", detail: null };
  const read = await GithubTracker.readIssue(run.fixture);
  let fixture = read.status === "found" ? read.value.state : "unknown";
  let detail: string | null =
    fixture === "unknown" || fixture !== run.fixtureState
      ? `The fixture ${run.fixture.repository}#${run.fixture.issue} is ${fixture}, and it was ${run.fixtureState ?? "unknown"} before the run. Inspect it before cleanup.`
      : null;
  for (const write of run.writes) {
    const observed = await TrackerUpdate.observe({
      provider: "github",
      step: write.step,
      target: { repository: run.fixture.repository, issue: write.issue },
      operationId: write.operationId,
      expectedActor: write.expectedActor,
      contentIdentity: write.contentIdentity,
      resourceId: null,
      sentWrites: 1,
      now: new Date().toISOString(),
    });
    if (observed.kind === "comment") {
      if (
        !observed.coverage.complete ||
        observed.exactMatches.length > 1 ||
        observed.editedMatches.length > 0 ||
        observed.actorMismatches.length > 0
      ) {
        detail = `The fixture write ${write.operationId} cannot be settled from a complete, unique comment scan.`;
      }
      fixture += `, ${write.step} ${observed.exactMatches.length === 1 ? "written" : observed.coverage.complete ? "absent" : "unknown"}`;
    } else {
      if (observed.read !== "found" || !observed.eventCoverage.complete)
        detail = `The fixture closure ${write.operationId} cannot be settled from a complete read.`;
      fixture += `, closure ${observed.state ?? "unknown"}`;
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
    const fixtureStatus =
      run === null
        ? worktree.status === "absent" && agents.length === 0
          ? { fixture: "recorded", detail: null }
          : { fixture: "unrecorded", detail: null }
        : await inspectFixture(run);
    detail ??= fixtureStatus.detail;
    resources.push({
      directory,
      runId,
      agents,
      worktree: worktree.status === "found" ? "present" : worktree.status,
      workspaceId: worktree.status === "found" ? worktree.value.workspaceId : null,
      fixture: fixtureStatus.fixture,
      detail,
    });
  }
  return {
    directory: root(projectRoot),
    directories,
    resources,
    cleanupId: ContentIdentity.of(resources),
  };
}

/** Refuses an unknown effect or another workspace occupant instead of removing its checkout. */
export async function cancelRuns(inspected: Awaited<ReturnType<typeof inspectRuns>>) {
  for (const resource of inspected.resources) {
    if (resource.detail !== null)
      return { status: "blocked" as const, ...inspected, detail: resource.detail };
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
    await removeScratch(resource.directory);
  }
  return { status: "removed" as const, ...inspected };
}
