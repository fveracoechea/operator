// Bun has no path manipulation API.
import { basename, dirname } from "node:path";
import { HerdrControl } from "../herdr-control/main.ts";
import { ProjectGate } from "../project-gate/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { approvalCovers, readApproval } from "./approvals.ts";
import { mutate, readState, type RequestFailure, type StateFailure } from "./operations.ts";
import { requireOwnership } from "./ownership.ts";
import {
  checkoutOf,
  FRESH_SERIES_ACTION,
  failedRunsAtKey,
  type GateCheckoutRow,
  type GateKey,
  type GateRunRecord,
  gateRunRecordOf,
  insertGateRun,
  keyStatus,
  keyText,
  readGateRun,
  runningRunOf,
} from "./gate-runs.ts";
import { sourceSlug } from "./integration.ts";
import { gateCheckouts, workSources } from "./schema.ts";
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
  | { status: "gate-passed"; key: GateKey; commit: string; runIds: string[] }
  | { status: "gate-running"; runId: string; detail: string }
  | { status: "gate-runner-unknown"; runId: string; detail: string }
  | { status: "fresh-series-not-needed"; key: GateKey }
  | {
      status: "fresh-series-not-approved";
      key: GateKey;
      // The exact request a person approves: the key and every failed run it answers.
      request: { action: string; targets: string[]; scope: string; requestRevision: string };
      found: string;
    }
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
async function runnerLive(run: { id: string; paneId: string }) {
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

/**
 * Starts one gate run on the integration base of one source (ADR 0021). The run is recorded
 * before the runner line is typed, and the line holds only the runner command, the run id, and
 * the project root. One run of a source runs at a time, and a run with no outcome is replaced
 * only after its pane shows that the runner stopped.
 */
// oxlint-disable-next-line complexity -- Each refusal is one recorded rule of the gate start.
export async function startGateRun(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  sourceId: string;
  commit: string;
  approvalId: string | null;
  runnerLine: (runId: string) => string;
}): Promise<GateStartResult> {
  const keyed = await readGateKey({ projectRoot: request.projectRoot, commit: request.commit });
  if (keyed.status !== "read") {
    return keyed;
  }
  const { gate, key } = keyed;
  const keyName = keyText(key);

  const read = await readState(request.projectRoot, (db) => {
    const owned = requireOwnership(db, request.ownerToken);
    if (owned.status === "unowned") return { status: "unowned" as const };
    if (owned.status === "stale") {
      return { status: "ownership-stale" as const, ownership: owned.ownership };
    }
    const source = db.select().from(workSources).where(eq(workSources.id, request.sourceId)).all();
    if (source.length === 0) {
      return { status: "unknown-source" as const, sourceId: request.sourceId };
    }
    const approval = request.approvalId === null ? null : readApproval(db, request.approvalId);
    return {
      status: "read" as const,
      running: runningRunOf(db, request.sourceId),
      verdict: keyStatus(db, key),
      failed: failedRunsAtKey(db, key).map((one) => one.id),
      approval,
      checkout: checkoutOf(db, request.sourceId),
    };
  });
  if (read.status !== "read") {
    return read;
  }

  let replaces: string | null = null;
  if (read.running !== null) {
    const runner = await runnerLive(read.running);
    if (runner.status === "unknown") {
      return { status: "gate-runner-unknown", runId: read.running.id, detail: runner.detail };
    }
    if (runner.status === "live") {
      return {
        status: "gate-running",
        runId: read.running.id,
        detail: `Gate run ${read.running.id} of this source is still running at commit ${read.running.commit}.`,
      };
    }
    replaces = read.running.id;
  }

  if (read.verdict.status === "passed") {
    return {
      status: "gate-passed",
      key,
      commit: gate.commit,
      runIds: read.verdict.passed.map((one) => one.id),
    };
  }

  // Only a person starts a fresh series, with an approval that names the key and every failed run.
  let series: string | null = null;
  if (request.approvalId !== null) {
    if (read.failed.length === 0) {
      return { status: "fresh-series-not-needed", key };
    }
    const check = {
      action: FRESH_SERIES_ACTION,
      targets: [keyName, ...read.failed],
      scope: request.sourceId,
      requestRevision: keyName,
    };
    const coverage = read.approval === null ? null : approvalCovers(read.approval, check);
    if (coverage?.status !== "covers") {
      return {
        status: "fresh-series-not-approved",
        key,
        request: check,
        found:
          coverage === null
            ? `No approval ${request.approvalId} is recorded.`
            : coverage.status === "revoked"
              ? `Approval ${request.approvalId} was revoked.`
              : `Approval ${request.approvalId} does not match the ${coverage.field}.`,
      };
    }
    series = request.approvalId;
  }

  const checkout = await ensureCheckout({
    projectRoot: request.projectRoot,
    sourceId: request.sourceId,
    commit: gate.commit,
    recorded: read.checkout,
  });
  if (checkout.status !== "ready") {
    return checkout;
  }

  const runId = crypto.randomUUID();
  const { repeated, result } = await mutate<
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
        sourceId: request.sourceId,
        commit: gate.commit,
        key,
        approvalId: request.approvalId,
      },
    },
    ({ tx, now }) => {
      const running = runningRunOf(tx, request.sourceId);
      if (running !== null && running.id !== replaces) {
        return {
          commit: false,
          outcome: {
            status: "gate-running" as const,
            runId: running.id,
            detail: `Gate run ${running.id} of this source started first.`,
          },
        };
      }
      if (checkoutOf(tx, request.sourceId) === null) {
        tx.insert(gateCheckouts)
          .values({ ...checkout.checkout, createdAt: now })
          .run();
      }
      insertGateRun(tx, {
        runId,
        sourceId: request.sourceId,
        subject: { kind: "base" },
        key,
        commit: gate.commit,
        commands: gate.commands,
        series,
        replaces,
        ownerToken: request.ownerToken,
        paneId: checkout.checkout.paneId,
        now,
      });
      return { commit: true, outcome: { status: "recorded" as const, runId } };
    },
  );
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
