// Bun has no path manipulation API.
import { basename, dirname } from "node:path";
import { HerdrControl } from "../herdr-control/main.ts";
import { ProjectGate } from "../project-gate/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { readApproval } from "./approvals.ts";
import { GateRun, type GateRunNext, type GateRunRefusal, type RunnerRead } from "./gate-machine.ts";
import { mutate, readState, type RequestFailure, type StateFailure } from "./operations.ts";
import { requireOwnership } from "./ownership.ts";
import {
  checkoutOf,
  failedRunsAtKey,
  type DeclaredCommand,
  type GateCheckoutRow,
  type GateKey,
  type GatePlace,
  type GateStep,
  type GateSubject,
  type OpenPlace,
  type GateRunRecord,
  gateRunRecordOf,
  keyStatus,
  readGateRun,
  runningRunOf,
} from "./gate-runs.ts";
import { sourceSlug } from "./integration.ts";
import { gateCheckouts, gateRuns, workSources } from "./schema.ts";
import { eq } from "drizzle-orm";

type GateRead = Awaited<ReturnType<typeof ProjectGate.read>>;

export type GateStartResult =
  | { status: "started"; run: GateRunRecord; line: string; repeated: boolean }
  | {
      status: "runner-not-typed";
      run: GateRunRecord;
      detail: string;
      uncertain: boolean;
    }
  | { status: "unknown-source"; sourceId: string }
  | { status: "project-gate-unusable"; gate: Exclude<GateRead, { status: "declared" }> }
  | { status: "commit-unread"; commit: string; detail: string }
  | GateRunRefusal["start"]
  | { status: "gate-running"; runId: string; detail: string }
  // A gated move with no commit to gate passed with no run, so it names no tree.
  | { status: "nothing-to-gate"; commit: string; declarationIdentity: string }
  | { status: "gate-branch-exists"; branch: string; path: string }
  | { status: "gate-checkout-failed"; detail: string; uncertain: boolean }
  | {
      status: "gate-checkout-unplanned";
      branch: string;
      path: string;
      planned: string;
      found: string;
    }
  | StateFailure
  | RequestFailure;

async function git(repository: string, args: string[]) {
  const invoked = await ToolInvocation.run({
    tool: "git",
    args: ["-C", repository, ...args],
    timeoutMs: 30_000,
  });
  return invoked.status === "completed" && invoked.exitCode === 0
    ? { status: "read" as const, value: invoked.stdout.trim() }
    : {
        status: "unread" as const,
        detail:
          invoked.status === "completed" ? invoked.stderr.trim() || "git refused" : invoked.detail,
      };
}

/**
 * The key of one commit: the identity of its tree and of the gate it declares. The gate is read
 * at the commit, never from a working tree.
 */
export async function readGateKey(request: { projectRoot: string; commit: string }): Promise<
  | {
      status: "read";
      gate: Extract<GateRead, { status: "declared" }>;
      key: GateKey;
    }
  | Extract<GateStartResult, { status: "project-gate-unusable" | "commit-unread" }>
> {
  const gate = await ProjectGate.read({ repository: request.projectRoot, commit: request.commit });
  if (gate.status !== "declared") {
    return { status: "project-gate-unusable", gate };
  }
  const tree = await git(request.projectRoot, ["rev-parse", `${gate.commit}^{tree}`]);
  return tree.status === "read"
    ? { status: "read", gate, key: { tree: tree.value, declarationIdentity: gate.identity } }
    : { status: "commit-unread", commit: request.commit, detail: tree.detail };
}

/** A runner is live while a process in its pane names its run. The shell itself stays. */
async function runnerLive(run: { id: string; paneId: string }): Promise<RunnerRead> {
  const read = await HerdrControl.readPaneProcesses({ paneId: run.paneId });
  if (read.status === "unknown") {
    return { status: "unknown" as const, detail: read.detail };
  }
  const live =
    read.status === "found" &&
    read.value.foreground.some(
      (one) => one.pid !== read.value.shellPid && one.command.includes(run.id),
    );
  return { status: live ? ("live" as const) : ("stopped" as const) };
}

/**
 * Creates the one gate checkout of a source with Herdr, or adopts the one Herdr already holds at
 * the planned path. Herdr ignores `--base` when the branch already exists, so a branch that
 * exists is refused before the call, and the HEAD of a new checkout is verified after it.
 */
async function ensureCheckout(request: {
  projectRoot: string;
  sourceId: string;
  commit: string;
  recorded: GateCheckoutRow | null;
}): Promise<
  | { status: "ready"; checkout: Omit<GateCheckoutRow, "createdAt">; created: boolean }
  | Extract<
      GateStartResult,
      { status: "gate-branch-exists" | "gate-checkout-failed" | "gate-checkout-unplanned" }
    >
> {
  if (request.recorded !== null) {
    return { status: "ready", checkout: request.recorded, created: false };
  }

  const branch = `operator/gate/${sourceSlug(request.sourceId)}`;
  const path = `${dirname(request.projectRoot)}/${basename(request.projectRoot)}-gate-${sourceSlug(request.sourceId)}`;
  const found = await HerdrControl.findWorktree({ repoRoot: request.projectRoot, path });
  let workspaceId: string;
  let created = false;
  if (
    found.status === "found" &&
    found.value.branch === branch &&
    found.value.workspaceId !== null
  ) {
    // An earlier start created it and stopped before it recorded it.
    workspaceId = found.value.workspaceId;
  } else {
    const exists = await git(request.projectRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    if (exists.status === "read" || found.status === "found") {
      return { status: "gate-branch-exists", branch, path };
    }
    const made = await HerdrControl.createWorktree({
      repoRoot: request.projectRoot,
      path,
      branch,
      baseCommit: request.commit,
      label: `gate ${request.sourceId}`,
    });
    if (made.status !== "succeeded") {
      return {
        status: "gate-checkout-failed",
        detail: made.status === "failed" ? `${made.code}: ${made.detail}` : made.detail,
        uncertain: made.status === "uncertain",
      };
    }
    workspaceId = made.value.workspaceId;
    created = true;
  }

  const pane = await HerdrControl.findRootPane({ workspaceId });
  if (pane.status !== "found") {
    return {
      status: "gate-checkout-failed",
      detail:
        pane.status === "absent" ? `Herdr holds no pane in workspace ${workspaceId}.` : pane.detail,
      uncertain: pane.status === "unknown",
    };
  }

  const checkout = {
    sourceId: request.sourceId,
    path,
    branch,
    workspaceId,
    paneId: pane.value.paneId,
  };
  if (created) {
    const head = await git(path, ["rev-parse", "HEAD"]);
    if (head.status !== "read" || head.value !== request.commit) {
      return {
        status: "gate-checkout-unplanned",
        branch,
        path,
        planned: request.commit,
        found: head.status === "read" ? head.value : head.detail,
      };
    }
  }
  return { status: "ready", checkout, created };
}

/** What one gate run gates, with the key, the commit, and the commands it runs. */
export type GateTarget = {
  sourceId: string;
  commit: string;
  key: GateKey;
  commands: DeclaredCommand[];
  subject: GateSubject;
  /** Where Herdr makes the gate checkout of the source when none is recorded yet. */
  checkoutBase: string;
};

type StartRequest = {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  approvalId: string | null;
  runnerLine: (runId: string) => string;
};

/**
 * Starts one gate run on the integration base of one source (ADR 0021). The run is recorded
 * before the runner line is typed, and the line holds only the runner command, the run id, and
 * the project root. One run of a source runs at a time, and a run with no outcome is replaced
 * only after its pane shows that the runner stopped.
 */
export async function startGateRun(
  request: StartRequest & { sourceId: string; commit: string },
): Promise<GateStartResult> {
  const keyed = await readGateKey({ projectRoot: request.projectRoot, commit: request.commit });
  if (keyed.status !== "read") {
    return keyed;
  }
  return startRun({
    ...request,
    target: {
      sourceId: request.sourceId,
      commit: keyed.gate.commit,
      key: keyed.key,
      commands: keyed.gate.commands,
      subject: { kind: "base" },
      checkoutBase: keyed.gate.commit,
    },
  });
}

/**
 * The start on a move that gates its places in order (ADR 0021). A move whose places all passed
 * starts nothing and names the key of its last place, or nothing to gate when it has no place. A
 * running place waits for its one run, and any other place goes to `start`.
 */
export async function startOnStep<Place extends GatePlace, R>(request: {
  step: GateStep<Place>;
  passed: { commit: string; declarationIdentity: string; tree: string | null };
  /** The move, as the detail of a running place names it. */
  range: string;
  start: (place: OpenPlace<Place>) => Promise<R>;
}): Promise<GateStartResult | R> {
  const { step, passed } = request;
  if (step.status === "passed") {
    const { commit, declarationIdentity, tree } = passed;
    return tree === null
      ? { status: "nothing-to-gate", commit, declarationIdentity }
      : { status: "gate-passed", key: { tree, declarationIdentity }, commit, runIds: [] };
  }
  if (step.status === "running") {
    const [runId] = step.runIds;
    return {
      status: "gate-running",
      runId,
      detail: `Gate run ${step.runIds.join(", ")} still runs at commit ${step.commit} of ${request.range}.`,
    };
  }
  return request.start(step);
}

/** The facts of one start that crew state holds, read under the owner. */
async function readStartFacts(request: StartRequest & { target: GateTarget }) {
  const { sourceId, key } = request.target;
  return readState(request.projectRoot, (db) => {
    const owned = requireOwnership(db, request.ownerToken);
    if (owned.status === "unowned") return { status: "unowned" as const };
    if (owned.status === "stale") {
      return { status: "ownership-stale" as const, ownership: owned.ownership };
    }
    const source = db.select().from(workSources).where(eq(workSources.id, sourceId)).all();
    if (source.length === 0) {
      return { status: "unknown-source" as const, sourceId };
    }
    return {
      status: "read" as const,
      running: runningRunOf(db, sourceId),
      verdict: keyStatus(db, key),
      failed: failedRunsAtKey(db, key).map((one) => one.id),
      approval:
        request.approvalId === null
          ? null
          : { id: request.approvalId, row: readApproval(db, request.approvalId) },
      checkout: checkoutOf(db, sourceId),
    };
  });
}

/**
 * Records the run, its checkout when none is recorded, and the stop of the run it replaces, in
 * one transaction. A run of the source that started in between wins.
 */
async function recordStart(
  request: StartRequest & { target: GateTarget },
  start: GateRunNext["start"],
  checkout: Omit<GateCheckoutRow, "createdAt">,
) {
  const { target } = request;
  const { sourceId } = target;
  const runId = crypto.randomUUID();
  return mutate<
    | { status: "recorded"; runId: string }
    | { status: "gate-running"; runId: string; detail: string }
  >(
    {
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: request.ownerToken,
      now: new Date().toISOString(),
      operation: "gate_run",
      input: {
        sourceId,
        commit: target.commit,
        key: target.key,
        subject: target.subject,
        approvalId: request.approvalId,
      },
    },
    ({ tx, now }) => {
      const running = runningRunOf(tx, sourceId);
      if (running !== null && running.id !== start.replaces) {
        return {
          commit: false,
          outcome: {
            status: "gate-running" as const,
            runId: running.id,
            detail: `Gate run ${running.id} of this source started first.`,
          },
        };
      }
      if (checkoutOf(tx, sourceId) === null) {
        tx.insert(gateCheckouts)
          .values({ ...checkout, createdAt: now })
          .run();
      }
      // The replaced run keeps no outcome. It stops, so it never reads as running again.
      const replaced = start.replaces === null ? null : readGateRun(tx, start.replaces);
      const stop = replaced === null ? null : GateRun.decide("replace", { run: replaced });
      if (replaced !== null && stop !== null && "next" in stop) {
        tx.update(gateRuns)
          .set({ state: stop.next, detail: `Replaced by gate run ${runId}.` })
          .where(eq(gateRuns.id, replaced.id))
          .run();
      }
      tx.insert(gateRuns)
        .values({
          id: runId,
          sourceId,
          subject: JSON.stringify(target.subject),
          tree: target.key.tree,
          declarationIdentity: target.key.declarationIdentity,
          commit: target.commit,
          commands: JSON.stringify(target.commands),
          series: start.series,
          replaces: start.replaces,
          ownerToken: request.ownerToken,
          paneId: checkout.paneId,
          state: start.state,
          detail: null,
          startedAt: now,
          begunAt: null,
          finishedAt: null,
        })
        .run();
      return { commit: true, outcome: { status: "recorded" as const, runId } };
    },
  );
}

/** Starts one run on one target, under the rules every gate run shares. */
export async function startRun(
  request: StartRequest & { target: GateTarget },
): Promise<GateStartResult> {
  const { target } = request;
  const read = await readStartFacts(request);
  if (read.status !== "read") {
    return read;
  }
  const decided = GateRun.decide("start", {
    sourceId: target.sourceId,
    key: target.key,
    commit: target.commit,
    running:
      read.running === null ? null : { run: read.running, runner: await runnerLive(read.running) },
    verdict: read.verdict,
    failed: read.failed,
    approval: read.approval,
  });
  if ("refused" in decided) {
    return decided.refused;
  }

  const checkout = await ensureCheckout({
    projectRoot: request.projectRoot,
    sourceId: target.sourceId,
    commit: target.checkoutBase,
    recorded: read.checkout,
  });
  if (checkout.status !== "ready") {
    return checkout;
  }
  const { repeated, result } = await recordStart(request, decided.next, checkout.checkout);
  if (result.status !== "recorded") {
    return result;
  }

  const recorded = await readState(request.projectRoot, (db) => {
    const run = readGateRun(db, result.runId);
    return run === null ? null : gateRunRecordOf(db, run);
  });
  if (recorded === null || "status" in recorded) {
    return recorded ?? { status: "state-missing", path: request.projectRoot };
  }

  const line = request.runnerLine(result.runId);
  // A repeated request recorded this run before, and its line was typed then.
  if (repeated) {
    return { status: "started", run: recorded, line, repeated };
  }
  const typed = await HerdrControl.runInPane({ paneId: checkout.checkout.paneId, line });
  return typed.status === "succeeded"
    ? { status: "started", run: recorded, line, repeated }
    : {
        status: "runner-not-typed",
        run: recorded,
        detail: typed.status === "failed" ? `${typed.code}: ${typed.detail}` : typed.detail,
        uncertain: typed.status === "uncertain",
      };
}
