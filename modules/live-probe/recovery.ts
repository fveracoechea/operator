// Bun has no atomic file rename or recursive directory removal API.
import { mkdir, rename, rm } from "node:fs/promises";
import { ContentIdentity } from "../content-identity/main.ts";
import { GithubTracker } from "../github-tracker/main.ts";
import { HerdrControl } from "../herdr-control/main.ts";
import { TrackerUpdate } from "../tracker-update/main.ts";
import { z } from "zod";
import { isIdleShell, probeAgentName } from "./agents.ts";
import { commitProbeWork, PROBE_DIRECTORY, removeScratch, scratchDirectories } from "./scratch.ts";

const fixtureSchema = z.object({
  repository: z.string(),
  issue: z.number(),
  mapIssue: z.number().optional(),
});
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
  fixture: fixtureSchema.nullable(),
  fixtureState: z.string().nullable(),
  writes: z.array(writeSchema),
});
/** The configured fixture issue, and the map issue its amendment check writes on. */
export type Fixture = z.infer<typeof fixtureSchema>;
/** One journaled fixture write: its intent, and its outcome once the tracker answered. */
export type Write = z.infer<typeof writeSchema>;
type Run = z.infer<typeof runSchema>;
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

type Inspected = { status: string; detail: string | null };
type Reading = Awaited<ReturnType<typeof TrackerUpdate.read>>;
type ClosureReading = Extract<Reading["observation"], { kind: "closure" }>;
type CommentReading = Extract<Reading["observation"], { kind: "comment" }>;

/** What the tracker answered to a journal outcome. A tool this machine lacks sent no write. */
const SENT_AS = {
  succeeded: "succeeded",
  failed: "failed",
  unavailable: "failed",
  uncertain: "uncertain",
} as const;

/** A reopen is proven only by a reopen event after the recorded count and an open fixture. */
async function inspectReopen(fixture: Fixture, state: string, write: Write): Promise<Inspected> {
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

/**
 * A closure reads its own observation and not the verdict, because the probe reopens the
 * fixture after the close.
 */
function inspectClosure(write: Write, observed: ClosureReading): Inspected {
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

/**
 * A comment takes its outcome from the tracker verdict, but only after a complete, unique scan.
 * A verdict can verify one clean match on a partial scan, and the probe does not accept that.
 */
function inspectComment(
  write: Write,
  observed: CommentReading,
  verdict: Reading["verdict"],
): Inspected {
  const unique =
    observed.coverage.complete &&
    observed.exactMatches.length <= 1 &&
    observed.editedMatches.length === 0 &&
    observed.actorMismatches.length === 0;
  if (!unique) {
    return {
      status: `${write.step} uncertain`,
      detail: `The fixture write ${write.operationId} cannot be settled from a complete, unique comment scan.`,
    };
  }
  const settled =
    verdict.state === "verified"
      ? "written"
      : verdict.reason === "tracker.write_rejected"
        ? "absent"
        : null;
  return {
    status: `${write.step} ${settled ?? "uncertain"}`,
    detail:
      settled === null
        ? `The fixture comment ${write.operationId} has no proven outcome. An empty scan does not settle an uncertain write.`
        : null,
  };
}

async function inspectWrite(fixture: Fixture, state: string, write: Write): Promise<Inspected> {
  if (write.step === "reopen") return inspectReopen(fixture, state, write);
  const { observation, verdict } = await TrackerUpdate.read({
    provider: "github",
    step: write.step,
    target: { repository: fixture.repository, issue: write.issue },
    operationId: write.operationId,
    expectedActor: write.expectedActor,
    contentIdentity: write.contentIdentity,
    resourceId: null,
    intendedReason: "completed",
    writes: [SENT_AS[write.outcome ?? "uncertain"]],
    now: new Date().toISOString(),
  });
  return observation.kind === "closure"
    ? inspectClosure(write, observation)
    : inspectComment(write, observation, verdict);
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

type Worktree = Awaited<ReturnType<typeof HerdrControl.findWorktree>> | { status: "absent" };

/** Finds the probe's own agents, and names the last one Herdr cannot place in its workspace. */
async function agentsOf(
  projectRoot: string,
  runId: string,
  worktree: Worktree,
): Promise<{ agents: string[]; detail: string | null }> {
  const agents: string[] = [];
  let detail: string | null = null;
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
  return { agents, detail };
}

/** Reads one scratch directory: its agents, its worktree, its fixture, and what blocks cleanup. */
async function inspectResource(projectRoot: string, directory: string): Promise<Resource> {
  const runId = directory.slice(root(projectRoot).length + 1);
  const run = await readRun(projectRoot, runId);
  // A crash before Git init has no repository for Herdr to list.
  const worktree: Worktree = (await Bun.file(`${directory}/repo/.git/HEAD`).exists())
    ? await HerdrControl.findWorktree({
        repoRoot: `${directory}/repo`,
        path: `${directory}/worktree`,
      })
    : { status: "absent" };
  const found = await agentsOf(projectRoot, runId, worktree);
  let resourceDetail = found.detail ?? (worktree.status === "unknown" ? worktree.detail : null);
  if (
    run === null &&
    !(await ownsLegacyRepository(directory, runId, worktree.status === "found"))
  ) {
    resourceDetail =
      "This scratch repository has no probe journal or committed probe ownership proof. Preserve it for inspection.";
  }
  const fixtureStatus =
    run !== null
      ? await inspectFixture(run)
      : {
          fixture:
            worktree.status === "absent" && found.agents.length === 0 ? "recorded" : "unrecorded",
          detail: null,
        };
  return {
    directory,
    runId,
    agents: found.agents,
    worktree: worktree.status === "found" ? "present" : worktree.status,
    workspaceId: worktree.status === "found" ? worktree.value.workspaceId : null,
    fixture: fixtureStatus.fixture,
    detail: resourceDetail ?? fixtureStatus.detail,
    resourceDetail,
    fixtureDetail: fixtureStatus.detail,
  };
}

/** A read-only inventory for both status and the approval bound to cleanup. */
export async function inspectRuns(projectRoot: string) {
  const directories = await scratchDirectories(projectRoot);
  const resources: Resource[] = [];
  for (const directory of directories) {
    resources.push(await inspectResource(projectRoot, directory));
  }
  return {
    projectRoot,
    directory: root(projectRoot),
    directories,
    resources,
    cleanupId: ContentIdentity.of(resources),
  };
}

/** The steps of one approved probe cleanup. A refusal ends the cleanup in its own status. */
export type CleanupState = "inspected" | "approved" | "checked" | "disposed" | "removed";
export type CleanupEvent = "approve" | "cancel" | "dispose" | "inspect";
/** What the caller reads before it asks for each event. `decideCleanup` reads nothing else. */
export type CleanupFacts = {
  approve: { directories: number; approvedCleanupId: string | undefined; cleanupId: string };
  cancel: { blocker: string | null };
  dispose: { blocker: string | null };
  inspect: { remaining: number };
};
type CleanupRefusals = {
  approve: "nothing" | "approval-required" | "approval-stale";
  cancel: "blocked";
  dispose: "blocked";
  inspect: "pending-fixture";
};
type CleanupRow<Event extends CleanupEvent> = {
  from: CleanupState;
  guards: ReadonlyArray<readonly [CleanupRefusals[Event], (facts: CleanupFacts[Event]) => boolean]>;
  next: CleanupState;
};

/**
 * The probe cleanup transitions. The guards run in order, and the first that holds is the refusal.
 * A cancel checks every resource before any is disposed, so a blocked resource stops all of them.
 */
const CLEANUP: { [Event in CleanupEvent]: CleanupRow<Event> } = {
  approve: {
    from: "inspected",
    guards: [
      ["nothing", (facts) => facts.directories === 0],
      ["approval-required", (facts) => facts.approvedCleanupId === undefined],
      ["approval-stale", (facts) => facts.approvedCleanupId !== facts.cleanupId],
    ],
    next: "approved",
  },
  cancel: {
    from: "approved",
    guards: [["blocked", (facts) => facts.blocker !== null]],
    next: "checked",
  },
  dispose: {
    from: "checked",
    guards: [["blocked", (facts) => facts.blocker !== null]],
    next: "disposed",
  },
  // An unresolved fixture keeps its journal, so a directory left after disposal is pending.
  inspect: {
    from: "disposed",
    guards: [["pending-fixture", (facts) => facts.remaining > 0]],
    next: "removed",
  },
};

export function decideCleanup<Event extends CleanupEvent>(
  state: CleanupState,
  event: Event,
  facts: CleanupFacts[Event],
): { next: CleanupState } | { refused: CleanupRefusals[Event] } {
  const row: CleanupRow<Event> = CLEANUP[event];
  if (state !== row.from) {
    throw new Error(`A probe cleanup cannot ${event} from ${state}.`);
  }
  const refusal = row.guards.find(([, holds]) => holds(facts));
  return refusal === undefined ? { next: row.next } : { refused: refusal[0] };
}

/** Refuses an unknown effect or another workspace occupant instead of removing its checkout. */
async function blockerOf(resource: Resource): Promise<string | null> {
  if (resource.resourceDetail !== null) return resource.resourceDetail;
  if (resource.worktree !== "present") return null;
  if (resource.workspaceId === null) return "Herdr did not name the probe workspace.";
  const listed = await HerdrControl.listAgents();
  if (listed.status !== "found") return "Herdr cannot list the workspace agents.";
  const occupied = listed.value.some(
    (agent) =>
      agent.paneId.startsWith(`${resource.workspaceId}:`) &&
      !resource.agents.includes(agent.name ?? ""),
  );
  return occupied ? "Another agent occupies the probe workspace." : null;
}

/** Stops one probe agent and proves its pane holds no live foreground process. */
async function stopProbeAgent(name: string): Promise<string | null> {
  const before = await HerdrControl.findAgent({ name });
  if (before.status !== "found") return `Herdr cannot identify ${name}'s pane.`;
  const stopped = await HerdrControl.stopAgent({ target: name, keys: ["Escape", "C-c"] });
  const after = await HerdrControl.findAgent({ name });
  if (after.status !== "absent") return `Herdr still reports ${name}: ${stopped.status}.`;
  const processes = await HerdrControl.readPaneProcesses({ paneId: before.value.paneId });
  const live =
    processes.status === "unknown" ||
    (processes.status === "found" &&
      processes.value.foreground.some((one) => !isIdleShell(one, processes.value.shellPid)));
  return live ? `The pane for ${name} still holds an unknown or live foreground process.` : null;
}

/** Stops the agents, removes the worktree, and deletes what the fixture no longer needs. */
async function dispose(resource: Resource): Promise<string | null> {
  const stopped = await firstDetail(resource.agents, stopProbeAgent);
  if (stopped !== null) return stopped;
  if (resource.worktree === "present" && resource.workspaceId !== null) {
    if ((await commitProbeWork(`${resource.directory}/worktree`)) === null) {
      return "The probe checkout cannot be committed before removal.";
    }
    const removed = await HerdrControl.removeWorktree({ workspaceId: resource.workspaceId });
    const after = await HerdrControl.findWorktree({
      repoRoot: `${resource.directory}/repo`,
      path: `${resource.directory}/worktree`,
    });
    if (after.status !== "absent") return `The probe worktree remains: ${removed.status}.`;
  }
  if (resource.fixtureDetail !== null) {
    // The worktree is gone, but the fixture still needs its write identities for reconciliation.
    await rm(`${resource.directory}/repo`, { recursive: true, force: true });
  } else {
    await removeScratch(resource.directory);
  }
  return null;
}

/** Runs one step for each item in order, and stops at the first that names a detail. */
async function firstDetail<Item>(
  items: Item[],
  step: (item: Item) => Promise<string | null>,
): Promise<string | null> {
  for (const item of items) {
    const detail = await step(item);
    if (detail !== null) return detail;
  }
  return null;
}

/**
 * Runs one probe cleanup through `decideCleanup`.
 * It reads the facts for each event, asks for the decision, and runs the effects of the step.
 */
export async function cancelRuns(
  inspected: Awaited<ReturnType<typeof inspectRuns>>,
  approvedCleanupId: string | undefined,
) {
  const approved = decideCleanup("inspected", "approve", {
    directories: inspected.directories.length,
    approvedCleanupId,
    cleanupId: inspected.cleanupId,
  });
  if ("refused" in approved) return { status: approved.refused, ...inspected };

  const blocker = await firstDetail(inspected.resources, blockerOf);
  const checked = decideCleanup(approved.next, "cancel", { blocker });
  if ("refused" in checked) {
    return { status: checked.refused, ...inspected, detail: blocker ?? "" };
  }

  const failure = await firstDetail(inspected.resources, dispose);
  const disposed = decideCleanup(checked.next, "dispose", { blocker: failure });
  if ("refused" in disposed) {
    return { status: disposed.refused, ...inspected, detail: failure ?? "" };
  }

  const remaining = await inspectRuns(inspected.projectRoot);
  const settled = decideCleanup(disposed.next, "inspect", {
    remaining: remaining.resources.length,
  });
  if ("refused" in settled) return { status: settled.refused, ...remaining };
  return { status: "removed" as const, ...inspected };
}
