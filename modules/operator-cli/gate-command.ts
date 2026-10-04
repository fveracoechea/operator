import { CrewState } from "../crew-state/main.ts";
import { GateRunner } from "../gate-runner/main.ts";
import { ProjectGate } from "../project-gate/main.ts";
import { type ParsedArguments, readMutation } from "./arguments.ts";
import { reportSharedFailure } from "./crew-result.ts";
import { type Handled, refuse, report } from "./result.ts";

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

type CandidateResult = Awaited<ReturnType<typeof CrewState.startCandidateGateRun>>;

/** Reports a candidate that has no run to start. Nothing was recorded. */
// oxlint-disable-next-line complexity -- Each refusal of a candidate keeps its own reason.
function reportCandidateRefusal(parsed: ParsedArguments, result: CandidateResult): Handled | null {
  const operation = "gate_run";
  switch (result.status) {
    case "unknown-assignment":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "invalid",
        reason: "unknown_assignment",
        detail: { assignmentId: result.assignmentId },
        lines: [`No assignment ${result.assignmentId} is recorded.`],
      });
    case "candidate-missing":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "invalid",
        reason: "assignment_not_awaiting_review",
        detail: { assignmentId: result.assignmentId, state: result.state },
        lines: [
          `Assignment ${result.assignmentId} is ${result.state} and holds no code result to land, so it has no candidate.`,
        ],
      });
    case "landing-lands-nothing":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "conflict",
        reason: "gate_passed",
        detail: { assignmentId: result.assignmentId, branch: result.branch, landed: result.landed },
        lines: [
          `The branch ${result.branch} already holds the reviewed patch in ${result.landed}, so nothing lands and nothing is gated. Accept it.`,
        ],
      });
    case "integration-branch-missing":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "missing-condition",
        reason: "integration_branch_missing",
        detail: { assignmentId: result.assignmentId, sourceId: result.sourceId },
        lines: [
          `Source ${result.sourceId} records no integration branch, so there is no candidate.`,
        ],
      });
    case "integration-branch-moved":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "conflict",
        reason: "integration_branch_moved",
        detail: { ...result },
        lines: [
          `The branch ${result.branch} holds ${result.found ?? "no commit"}, and the recorded tip is ${result.recordedTip}. The person puts it back.`,
        ],
      });
    case "integration-branch-checked-out":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "conflict",
        reason: "integration_branch_checked_out",
        detail: { ...result },
        lines: [`The branch ${result.branch} is checked out in ${result.worktrees.join(", ")}.`],
      });
    case "integration-branch-unread":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "uncertain",
        reason: "integration_branch_unread",
        detail: { ...result },
        lines: [`Git cannot read the branch ${result.branch}: ${result.detail}`],
      });
    case "landing-conflict":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "conflict",
        reason: "landing_conflict",
        detail: { ...result },
        lines: [
          `Commit ${result.commit} conflicts with the tip ${result.tip} in ${result.paths.join(", ")}, so there is no candidate to gate.`,
        ],
      });
    case "landing-patch-changed":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "conflict",
        reason: "landing_patch_changed",
        detail: { ...result },
        lines: [
          `Commit ${result.commit} would land on ${result.tip} as another patch, so there is no candidate to gate.`,
        ],
      });
    case "rewrite-published-range":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "conflict",
        reason: "rewrite_published_range",
        detail: { ...result },
        lines: [
          `Commit ${result.commit} is inside the range that pull request ${result.pullRequest ?? "(number not recorded)"} published, so it is never rewritten in place.`,
        ],
      });
    case "rewrite-tracker-recorded":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "conflict",
        reason: "rewrite_tracker_recorded",
        detail: { ...result },
        lines: [
          `A tracker step already ran for a result that this move of ${result.branch} takes back: ${result.steps.map((one) => `${one.step} of ${one.assignmentId}`).join(", ")}. Bring it to the person.`,
        ],
      });
    default:
      return null;
  }
}

// oxlint-disable-next-line complexity -- Each refusal of a gate start keeps its own reason.
async function runStart(parsed: ParsedArguments): Promise<Handled> {
  const mutation = readMutation(parsed);
  const { sourceId, baseCommit, assignmentId, newBase } = parsed.crew;
  if (mutation === null) {
    return "invalid-arguments";
  }
  const projectRoot = process.cwd();
  const shared = {
    projectRoot,
    ...mutation,
    approvalId: parsed.crew.approvalId ?? null,
    // The typed line holds no gate text and no token: only the runner, its run, and the root.
    runnerLine: (runId: string) =>
      ProjectGate.commandLine(
        operatorCommand("gate", "runner", "--run", runId, "--root", projectRoot),
      ),
  };
  // A run gates the integration base of a source, the candidate of one code result, or the next
  // commit of the rebuilt range of the take-out of a source, or the next place of a rebase onto
  // a new base.
  let result:
    | Awaited<ReturnType<typeof CrewState.startCandidateGateRun>>
    | Awaited<ReturnType<typeof CrewState.startTakeOutGateRun>>
    | Awaited<ReturnType<typeof CrewState.startRebaseGateRun>>;
  if (assignmentId !== undefined && sourceId === undefined && baseCommit === undefined) {
    result = await CrewState.startCandidateGateRun({ ...shared, assignmentId });
  } else if (assignmentId === undefined && sourceId !== undefined && baseCommit !== undefined) {
    result = await CrewState.startGateRun({ ...shared, sourceId, commit: baseCommit });
  } else if (assignmentId === undefined && sourceId !== undefined && newBase !== undefined) {
    result = await CrewState.startRebaseGateRun({ ...shared, sourceId, newBase });
  } else if (assignmentId === undefined && sourceId !== undefined) {
    result = await CrewState.startTakeOutGateRun({ ...shared, sourceId });
  } else {
    return "invalid-arguments";
  }
  if (reportSharedFailure(parsed, "gate_run", result)) {
    return "reported";
  }
  if (result.status === "rebase-refused") {
    const { preview } = result;
    return refuse({
      json: parsed.json,
      operation: "gate_run",
      outcome: "invalid",
      reason: preview.refusals[0]?.reason ?? "integration_branch_unread",
      detail: { refusals: preview.refusals, planPath: preview.planPath },
      lines: [
        `The rebase of ${preview.sourceId} is refused, so no place of it is gated: ${preview.refusals.map((one) => one.reason).join(", ")}.`,
        `Every refusal: ${preview.planPath}`,
      ],
    });
  }
  if (result.status === "rebase-gate-failed") {
    const { gate } = result;
    return refuse({
      json: parsed.json,
      operation: "gate_run",
      outcome: "conflict",
      reason: `gate_${gate.status}`,
      detail: { commit: gate.commit, parent: gate.parent, ...gate.key, runIds: gate.runIds },
      lines: [
        `The key of ${gate.parent === null ? "the new base" : "commit"} ${gate.commit} is ${gate.status} in gate run ${gate.runIds.join(", ")}, so nothing was started.`,
        "Nothing reruns a failed key by itself. Only the person starts a fresh series, with an approval.",
      ],
    });
  }
  if (result.status === "nothing-to-take-out") {
    return refuse({
      json: parsed.json,
      operation: "gate_run",
      outcome: "conflict",
      reason: "nothing_to_take_out",
      detail: { sourceId: result.sourceId },
      lines: [
        `The integration branch of ${result.sourceId} holds no withdrawn commit, so no take-out range is gated.`,
      ],
    });
  }
  const candidate = reportCandidateRefusal(parsed, result);
  if (candidate !== null) {
    return candidate;
  }
  const operation = "gate_run";

  switch (result.status) {
    case "started":
      report({
        json: parsed.json,
        result: {
          outcome: "pending",
          reason: "gate_run_started",
          blockers: [{ reason: "gate_running", runId: result.run.runId }],
          operation,
          data: { ...result.run, repeated: result.repeated },
        },
        lines: [
          ...runLines(result.run),
          "The runner records each outcome itself and wakes the Operator at the end. `operator crew next` shows `gate_running` until then.",
        ],
      });
      return "reported";
    case "runner-not-typed":
      return refuse({
        json: parsed.json,
        operation,
        outcome: result.uncertain ? "uncertain" : "failed",
        reason: "gate_runner_not_typed",
        detail: { runId: result.run.runId, detail: result.detail },
        lines: [
          `Gate run ${result.run.runId} is recorded, and Herdr did not take its runner line: ${result.detail}`,
          "The run proves nothing. Run `operator gate run` again; it replaces the run once its pane shows no runner.",
        ],
      });
    case "unknown-source":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "invalid",
        reason: "unknown_source",
        detail: { sourceId: result.sourceId },
        lines: [`No source ${result.sourceId} is registered.`],
      });
    case "project-gate-unusable": {
      const { gate } = result;
      return refuse({
        json: parsed.json,
        operation,
        outcome: "missing-condition",
        reason: `project_gate_${gate.status}`,
        detail: { commit: gate.commit, path: gate.path },
        lines: [
          `Commit ${gate.commit} declares no usable ${gate.path}, so there is no gate to run.`,
          `The person commits a valid ${gate.path} at the repository root.`,
        ],
      });
    }
    case "commit-unread":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "invalid",
        reason: "gate_commit_unread",
        detail: { commit: result.commit, detail: result.detail },
        lines: [`Git cannot read the tree of ${result.commit}: ${result.detail}`],
      });
    case "gate-passed":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "conflict",
        reason: "gate_passed",
        detail: { commit: result.commit, ...result.key, runIds: result.runIds },
        lines: [
          `The key of commit ${result.commit} already passed in gate run ${result.runIds.join(", ")}. Nothing was started.`,
        ],
      });
    // A move with no commit to gate reports as a passed key with an empty tree and no run.
    case "nothing-to-gate":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "conflict",
        reason: "gate_passed",
        detail: {
          commit: result.commit,
          tree: "",
          declarationIdentity: result.declarationIdentity,
          runIds: [],
        },
        lines: [
          `The key of commit ${result.commit} already passed in gate run . Nothing was started.`,
        ],
      });
    case "gate-running":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "pending",
        reason: "gate_running",
        detail: { runId: result.runId },
        lines: [result.detail, "One gate run of a source runs at a time. Wait for its outcome."],
      });
    case "gate-runner-unknown":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "uncertain",
        reason: "gate_runner_unknown",
        detail: { runId: result.runId, detail: result.detail },
        lines: [
          `Herdr cannot show whether the runner of gate run ${result.runId} stopped: ${result.detail}`,
          "A run is replaced only after its pane shows that its runner stopped.",
        ],
      });
    case "fresh-series-not-needed":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "invalid",
        reason: "fresh_series_not_needed",
        detail: { ...result.key },
        lines: ["This key holds no failed run, so there is nothing a fresh series answers."],
      });
    case "fresh-series-not-approved":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "missing-condition",
        reason: "fresh_series_not_approved",
        detail: { ...result.key, request: result.request, found: result.found },
        lines: [
          result.found,
          "Only a person starts a fresh series. The approval names the key and each failed run it answers:",
          `  action ${result.request.action}, scope ${result.request.scope}, targets ${result.request.targets.join(", ")}`,
        ],
      });
    case "gate-branch-exists":
      return refuse({
        json: parsed.json,
        operation,
        outcome: "conflict",
        reason: "gate_branch_exists",
        detail: { branch: result.branch, path: result.path },
        lines: [
          `The branch ${result.branch} already exists, and Herdr would ignore the planned commit for it.`,
          "Nothing was created. The person decides what to do with that branch.",
        ],
      });
    case "gate-checkout-failed":
      return refuse({
        json: parsed.json,
        operation,
        outcome: result.uncertain ? "uncertain" : "failed",
        reason: "gate_checkout_failed",
        detail: { detail: result.detail },
        lines: [`Herdr did not make the gate checkout: ${result.detail}`],
      });
    case "gate-checkout-unplanned":
      return refuse({
        json: parsed.json,
        operation,
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
      });
    default:
      return "invalid-arguments";
  }
}

/** The runner in the pane of the gate checkout. A person never needs to type this line. */
async function runRunner(parsed: ParsedArguments): Promise<Handled> {
  const { runId, projectRoot } = parsed.crew;
  if (runId === undefined || projectRoot === undefined) {
    return "invalid-arguments";
  }
  const done = await GateRunner.run({
    projectRoot,
    runId,
    wakeCommand: operatorCommand("wake", "check", "--root", projectRoot),
  });
  const finished = done.status === "passed" || done.status === "failed";
  report({
    json: parsed.json,
    result: {
      outcome: finished ? "completed" : "failed",
      reason: finished
        ? "gate_run_finished"
        : done.status === "stopped"
          ? "gate_run_stopped"
          : "gate_run_not_running",
      blockers: [],
      operation: "gate_runner",
      data: { runId, state: done.status },
    },
    lines: done.lines,
  });
  return "reported";
}

async function runShow(parsed: ParsedArguments): Promise<Handled> {
  const { runId } = parsed.crew;
  if (runId === undefined) {
    return "invalid-arguments";
  }
  const { result } = await CrewState.gateRun({ projectRoot: process.cwd(), runId });
  if (reportSharedFailure(parsed, "gate_show", result)) {
    return "reported";
  }
  if (result.status === "unknown-gate-run") {
    return refuse({
      json: parsed.json,
      operation: "gate_show",
      outcome: "invalid",
      reason: "unknown_gate_run",
      detail: { runId },
      lines: [`No gate run ${runId} is recorded.`],
    });
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

export async function runGate(words: string[], parsed: ParsedArguments): Promise<Handled> {
  if (words.length !== 1) {
    return "invalid-arguments";
  }
  if (words[0] === "run") return runStart(parsed);
  if (words[0] === "runner") return runRunner(parsed);
  return words[0] === "show" ? runShow(parsed) : "invalid-arguments";
}
