import { CrewState } from "../crew-state/main.ts";
import { GateRunner } from "../gate-runner/main.ts";
import { ProjectGate } from "../project-gate/main.ts";
import type { ParsedArguments } from "./arguments.ts";
import {
  answer,
  type Handled,
  type Reason,
  type Refusal,
  report,
  type SharedStatus,
} from "./result.ts";

type Started = Awaited<ReturnType<typeof CrewState.startGateRun>>;
type RunRecord = Extract<Started, { status: "started" }>["run"];

/** The Operator binary as this process runs it, so the runner and its wake use the same release. */
function operatorCommand(...args: string[]): string[] {
  return [process.execPath, Bun.main, ...args];
}

/** One run as a short summary. The output of each command stays in its stored artifact. */
function runLines(run: RunRecord): string[] {
  return [
    `Gate run ${run.runId} of source ${run.sourceId} at commit ${run.commit} is ${run.state}.`,
    ...run.commands.map(
      (one) =>
        `  ${one.name}: ${one.outcome ?? "no outcome yet"}${one.reason === null ? "" : ` (${one.reason})`}${one.outputPath === null ? "" : `, output in ${one.outputPath}`}`,
    ),
  ];
}

type Subject = Parameters<typeof CrewState.startGateRun>[0]["subject"];
type StartFlags = Pick<
  ParsedArguments["crew"],
  "assignmentId" | "sourceId" | "baseCommit" | "newBase"
>;

/**
 * The flags that choose the subject of a start. Each row names the flags it must not see, and
 * builds its subject when its own flags are given. A flag a row does not name is ignored.
 */
const subjectRows: {
  absent: (keyof StartFlags)[];
  subject: (flags: StartFlags) => Subject | undefined;
}[] = [
  {
    absent: ["sourceId", "baseCommit"],
    subject: ({ assignmentId }) =>
      assignmentId === undefined ? undefined : { kind: "candidate", assignmentId },
  },
  {
    absent: ["assignmentId"],
    subject: ({ sourceId, baseCommit }) =>
      sourceId === undefined || baseCommit === undefined
        ? undefined
        : { kind: "base", sourceId, commit: baseCommit },
  },
  {
    absent: ["assignmentId", "baseCommit"],
    subject: ({ sourceId, newBase }) =>
      sourceId === undefined || newBase === undefined
        ? undefined
        : { kind: "rebase", sourceId, newBase },
  },
  {
    absent: ["assignmentId", "baseCommit", "newBase"],
    subject: ({ sourceId }) =>
      sourceId === undefined ? undefined : { kind: "take-out", sourceId },
  },
];

/** The subject that the flags name, or nothing when they name none. */
function subjectOf(flags: StartFlags): Subject | undefined {
  for (const row of subjectRows) {
    const subject = row.absent.every((flag) => flags[flag] === undefined)
      ? row.subject(flags)
      : undefined;
    if (subject !== undefined) return subject;
  }
  return undefined;
}

/**
 * The statuses of a gate start that no answer holds. `operator gate run` reads them as invalid
 * arguments, as it always did.
 */
type Unanswered = "take-out-pending" | "rebase-pending";

type StartAnswers = {
  [S in Exclude<Started["status"], SharedStatus | Unanswered>]: (
    result: Extract<Started, { status: S }>,
  ) => Refusal;
};

/**
 * The answer to each status of a gate start. A refusal records nothing. The type holds every
 * status, so a new one cannot go unanswered.
 */
const startAnswers: StartAnswers = {
  started: (result) => ({
    outcome: "pending",
    reason: "gate_run_started",
    blockers: [{ reason: "gate_running", runId: result.run.runId }],
    data: { ...result.run, repeated: result.repeated },
    lines: [
      ...runLines(result.run),
      "The runner records each outcome itself and wakes the Operator at the end. `operator crew next` shows `gate_running` until then.",
    ],
  }),
  "runner-not-typed": (result) => ({
    outcome: result.uncertain ? "uncertain" : "failed",
    reason: "gate_runner_not_typed",
    detail: { runId: result.run.runId, detail: result.detail },
    lines: [
      `Gate run ${result.run.runId} is recorded, and Herdr did not take its runner line: ${result.detail}`,
      "The run proves nothing. Run `operator gate run` again; it replaces the run once its pane shows no runner.",
    ],
  }),
  "rebase-refused": ({ preview }) => ({
    outcome: "invalid",
    reason: preview.refusals[0]?.reason ?? "integration_branch_unread",
    detail: { refusals: preview.refusals, planPath: preview.planPath },
    lines: [
      `The rebase of ${preview.sourceId} is refused, so no place of it is gated: ${preview.refusals.map((one) => one.reason).join(", ")}.`,
      `Every refusal: ${preview.planPath}`,
    ],
  }),
  "rebase-gate-failed": ({ gate }) => ({
    outcome: "conflict",
    reason: `gate_${gate.status}`,
    detail: { commit: gate.commit, parent: gate.parent, ...gate.key, runIds: gate.runIds },
    lines: [
      `The key of ${gate.parent === null ? "the new base" : "commit"} ${gate.commit} is ${gate.status} in gate run ${gate.runIds.join(", ")}, so nothing was started.`,
      "Nothing reruns a failed key by itself. Only the person starts a fresh series, with an approval.",
    ],
  }),
  "nothing-to-take-out": (result) => ({
    outcome: "conflict",
    reason: "nothing_to_take_out",
    detail: { sourceId: result.sourceId },
    lines: [
      `The integration branch of ${result.sourceId} holds no withdrawn commit, so no take-out range is gated.`,
    ],
  }),
  "unknown-assignment": (result) => ({
    outcome: "invalid",
    reason: "unknown_assignment",
    detail: { assignmentId: result.assignmentId },
    lines: [`No assignment ${result.assignmentId} is recorded.`],
  }),
  "candidate-missing": (result) => ({
    outcome: "invalid",
    reason: "assignment_not_awaiting_review",
    detail: { assignmentId: result.assignmentId, state: result.state },
    lines: [
      `Assignment ${result.assignmentId} is ${result.state} and holds no code result to land, so it has no candidate.`,
    ],
  }),
  "landing-lands-nothing": (result) => ({
    outcome: "conflict",
    reason: "gate_passed",
    detail: { assignmentId: result.assignmentId, branch: result.branch, landed: result.landed },
    lines: [
      `The branch ${result.branch} already holds the reviewed patch in ${result.landed}, so nothing lands and nothing is gated. Accept it.`,
    ],
  }),
  "integration-branch-missing": (result) => ({
    outcome: "missing-condition",
    reason: "integration_branch_missing",
    detail: { assignmentId: result.assignmentId, sourceId: result.sourceId },
    lines: [`Source ${result.sourceId} records no integration branch, so there is no candidate.`],
  }),
  "integration-branch-moved": (result) => ({
    outcome: "conflict",
    reason: "integration_branch_moved",
    detail: { ...result },
    lines: [
      `The branch ${result.branch} holds ${result.found ?? "no commit"}, and the recorded tip is ${result.recordedTip}. The person puts it back.`,
    ],
  }),
  "integration-branch-checked-out": (result) => ({
    outcome: "conflict",
    reason: "integration_branch_checked_out",
    detail: { ...result },
    lines: [`The branch ${result.branch} is checked out in ${result.worktrees.join(", ")}.`],
  }),
  "integration-branch-unread": (result) => ({
    outcome: "uncertain",
    reason: "integration_branch_unread",
    detail: { ...result },
    lines: [`Git cannot read the branch ${result.branch}: ${result.detail}`],
  }),
  "landing-conflict": (result) => ({
    outcome: "conflict",
    reason: "landing_conflict",
    detail: { ...result },
    lines: [
      `Commit ${result.commit} conflicts with the tip ${result.tip} in ${result.paths.join(", ")}, so there is no candidate to gate.`,
    ],
  }),
  "landing-patch-changed": (result) => ({
    outcome: "conflict",
    reason: "landing_patch_changed",
    detail: { ...result },
    lines: [
      `Commit ${result.commit} would land on ${result.tip} as another patch, so there is no candidate to gate.`,
    ],
  }),
  "rewrite-published-range": (result) => ({
    outcome: "conflict",
    reason: "rewrite_published_range",
    detail: { ...result },
    lines: [
      `Commit ${result.commit} is inside the range that pull request ${result.pullRequest ?? "(number not recorded)"} published, so it is never rewritten in place.`,
    ],
  }),
  "rewrite-tracker-recorded": (result) => ({
    outcome: "conflict",
    reason: "rewrite_tracker_recorded",
    detail: { ...result },
    lines: [
      `A tracker step already ran for a result that this move of ${result.branch} takes back: ${result.steps.map((one) => `${one.step} of ${one.assignmentId}`).join(", ")}. Bring it to the person.`,
    ],
  }),
  "unknown-source": (result) => ({
    outcome: "invalid",
    reason: "unknown_source",
    detail: { sourceId: result.sourceId },
    lines: [`No source ${result.sourceId} is registered.`],
  }),
  "project-gate-unusable": ({ gate }) => ({
    outcome: "missing-condition",
    reason: `project_gate_${gate.status}`,
    detail: { commit: gate.commit, path: gate.path },
    lines: [
      `Commit ${gate.commit} declares no usable ${gate.path}, so there is no gate to run.`,
      `The person commits a valid ${gate.path} at the repository root.`,
    ],
  }),
  "commit-unread": (result) => ({
    outcome: "invalid",
    reason: "gate_commit_unread",
    detail: { commit: result.commit, detail: result.detail },
    lines: [`Git cannot read the tree of ${result.commit}: ${result.detail}`],
  }),
  "gate-passed": (result) => ({
    outcome: "conflict",
    reason: "gate_passed",
    detail: { commit: result.commit, ...result.key, runIds: result.runIds },
    lines: [
      `The key of commit ${result.commit} already passed in gate run ${result.runIds.join(", ")}. Nothing was started.`,
    ],
  }),
  // A move with no commit to gate reports as a passed key with an empty tree and no run.
  "nothing-to-gate": (result) => ({
    outcome: "conflict",
    reason: "gate_passed",
    detail: {
      commit: result.commit,
      tree: "",
      declarationIdentity: result.declarationIdentity,
      runIds: [],
    },
    lines: [`The key of commit ${result.commit} already passed in gate run . Nothing was started.`],
  }),
  "gate-running": (result) => ({
    outcome: "pending",
    reason: "gate_running",
    detail: { runId: result.runId },
    lines: [result.detail, "One gate run of a source runs at a time. Wait for its outcome."],
  }),
  "gate-runner-unknown": (result) => ({
    outcome: "uncertain",
    reason: "gate_runner_unknown",
    detail: { runId: result.runId, detail: result.detail },
    lines: [
      `Herdr cannot show whether the runner of gate run ${result.runId} stopped: ${result.detail}`,
      "A run is replaced only after its pane shows that its runner stopped.",
    ],
  }),
  "fresh-series-not-needed": (result) => ({
    outcome: "invalid",
    reason: "fresh_series_not_needed",
    detail: { ...result.key },
    lines: ["This key holds no failed run, so there is nothing a fresh series answers."],
  }),
  "fresh-series-not-approved": (result) => ({
    outcome: "missing-condition",
    reason: "fresh_series_not_approved",
    detail: { ...result.key, request: result.request, found: result.found },
    lines: [
      result.found,
      "Only a person starts a fresh series. The approval names the key and each failed run it answers:",
      `  action ${result.request.action}, scope ${result.request.scope}, targets ${result.request.targets.join(", ")}`,
    ],
  }),
  "gate-branch-exists": (result) => ({
    outcome: "conflict",
    reason: "gate_branch_exists",
    detail: { branch: result.branch, path: result.path },
    lines: [
      `The branch ${result.branch} already exists, and Herdr would ignore the planned commit for it.`,
      "Nothing was created. The person decides what to do with that branch.",
    ],
  }),
  "gate-checkout-failed": (result) => ({
    outcome: result.uncertain ? "uncertain" : "failed",
    reason: "gate_checkout_failed",
    detail: { detail: result.detail },
    lines: [`Herdr did not make the gate checkout: ${result.detail}`],
  }),
  "gate-checkout-unplanned": (result) => ({
    outcome: "conflict",
    reason: "gate_checkout_unplanned",
    detail: {
      branch: result.branch,
      path: result.path,
      planned: result.planned,
      found: result.found,
    },
    lines: [
      `Herdr made the gate checkout ${result.path} at ${result.found}, not at the planned commit ${result.planned}.`,
      "No run was recorded.",
    ],
  }),
};

/** Starts one gate run on the subject that the flags name (ADR 0021). */
export async function runStart(
  parsed: ParsedArguments<"--request" | "--owner-token">,
): Promise<Handled> {
  const { requestId, ownerToken } = parsed.crew;
  const subject = subjectOf(parsed.crew);
  if (subject === undefined) {
    return "invalid-arguments";
  }
  const projectRoot = process.cwd();
  const result = await CrewState.startGateRun({
    projectRoot,
    requestId,
    ownerToken,
    subject,
    approvalId: parsed.crew.approvalId ?? null,
    // The typed line holds no gate text and no token: only the runner, its run, and the root.
    runnerLine: (runId: string) =>
      ProjectGate.commandLine(
        operatorCommand("gate", "runner", "--run", runId, "--root", projectRoot),
      ),
  });
  return answer(parsed, "gate_run", result, startAnswers) ? "reported" : "invalid-arguments";
}

type RunnerStatus = Awaited<ReturnType<typeof GateRunner.run>>["status"];
type RunnerOutcome = { outcome: "completed" | "failed"; reason: Reason };

/** A runner that ends at another status found its run not running, or could not write it. */
const RUNNER_NOT_RUNNING: RunnerOutcome = { outcome: "failed", reason: "gate_run_not_running" };

/** How each end of a runner reports. */
const runnerOutcomes: Partial<Record<RunnerStatus, RunnerOutcome>> = {
  passed: { outcome: "completed", reason: "gate_run_finished" },
  failed: { outcome: "completed", reason: "gate_run_finished" },
  stopped: { outcome: "failed", reason: "gate_run_stopped" },
};

/** The runner in the pane of the gate checkout. A person never needs to type this line. */
export async function runRunner(parsed: ParsedArguments<"--run" | "--root">): Promise<Handled> {
  const { runId, projectRoot } = parsed.crew;
  const done = await GateRunner.run({
    projectRoot,
    runId,
    wakeCommand: operatorCommand("wake", "check", "--root", projectRoot),
  });
  const { outcome, reason } = runnerOutcomes[done.status] ?? RUNNER_NOT_RUNNING;
  report({
    json: parsed.json,
    result: {
      outcome,
      reason,
      blockers: [],
      operation: "gate_runner",
      data: { runId, state: done.status },
    },
    lines: done.lines,
  });
  return "reported";
}

export async function runShow(parsed: ParsedArguments<"--run">): Promise<Handled> {
  const { runId } = parsed.crew;
  const { result } = await CrewState.gateRun({ projectRoot: process.cwd(), runId });
  if (
    answer(parsed, "gate_show", result, {
      "unknown-gate-run": () => ({
        outcome: "invalid",
        reason: "unknown_gate_run",
        detail: { runId },
        lines: [`No gate run ${runId} is recorded.`],
      }),
    })
  ) {
    return "reported";
  }
  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "gate_run_reported",
      blockers: [],
      operation: "gate_show",
      data: { ...result.run, checkoutPath: result.checkoutPath },
    },
    lines: runLines(result.run),
  });
  return "reported";
}
