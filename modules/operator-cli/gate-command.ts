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

// oxlint-disable-next-line complexity -- Each refusal of a gate start keeps its own reason.
async function runStart(parsed: ParsedArguments): Promise<Handled> {
  const mutation = readMutation(parsed);
  const { sourceId, baseCommit } = parsed.crew;
  if (mutation === null || sourceId === undefined || baseCommit === undefined) {
    return "invalid-arguments";
  }
  const projectRoot = process.cwd();
  const result = await CrewState.startGateRun({
    projectRoot,
    ...mutation,
    sourceId,
    commit: baseCommit,
    approvalId: parsed.crew.approvalId ?? null,
    // The typed line holds no gate text and no token: only the runner, its run, and the root.
    runnerLine: (runId) =>
      ProjectGate.commandLine(
        operatorCommand("gate", "runner", "--run", runId, "--root", projectRoot),
      ),
  });
  if (reportSharedFailure(parsed, "gate_run", result)) {
    return "reported";
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
