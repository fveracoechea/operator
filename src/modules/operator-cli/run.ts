import type { OperatorHome } from "../operator-home/main.ts";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { PullRequests } from "../pull-requests/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { z } from "zod";
import { Err, Ok, type Result } from "unthrown";
import type { Refusal } from "../../lib/cli-result.ts";
import { exitCodeOf, failure, respond, withOutputContext } from "./output.ts";
import { runProfiles } from "./profiles.ts";
import { runSkills } from "./skills.ts";
import { runLauncher } from "./launcher.ts";
import { runReadiness } from "./readiness.ts";
import { runSources } from "./sources.ts";
import { runDispatch } from "./dispatch.ts";
import { runAsk } from "./ask.ts";
import { pullRequestArgs, pullRequestExitCodes, runPullRequests } from "./pull-requests.ts";
import { reportArgs, runReports } from "./reports.ts";
import { runQuestions } from "./questions.ts";
import { runMessages } from "./messages.ts";
import { runObligations } from "./obligations.ts";
import { runReviews } from "./reviews.ts";
import { projectArgs, runProject } from "./projects.ts";
import { runSettings } from "./settings.ts";
import { startup } from "./startup.ts";
import { withOwnChanges } from "./own-changes.ts";
import { refuseUnsupervised } from "./supervision.ts";
import { invalidArguments, runUsage } from "./usage.ts";

type OperatorPaths = ReturnType<typeof OperatorHome.resolve>;
type Facts = Parameters<typeof WorkerKinds.decidePhase>[0];
type Event = NonNullable<Parameters<typeof WorkerKinds.decidePhase>[1]>;
type Worker = {
  source: { id: string; repository: string };
  assignment: { key: string };
  launch:
    | NonNullable<
        Extract<ReturnType<typeof DeviceState.readReport>, { tag: "Ok" }>["value"]["launch"]
      >
    | Extract<
        ReturnType<typeof DeviceState.readSources>,
        { tag: "Ok" }
      >["value"][number]["launches"][number];
  kind: ReturnType<typeof WorkerKinds.resolve>;
};

function missingFacts(): Result<never, Refusal> {
  return Err({
    reason: "state_corrupt",
    detail: "The recorded worker's phase facts are missing. Nothing changed.",
    next: {
      decider: "super-agent",
      question: "How should the missing worker records be investigated?",
    },
  });
}

function eventOf(args: string[]): Event | undefined {
  const pr = pullRequestArgs(args)?.operation;
  const report = reportArgs(args)?.command;
  if (pr === "pr_associate") return "associate";
  if (pr === "pr_round") return "round";
  if (pr === "pr_ready") return "ready";
  if (pr === "pr_wait") return "wait";
  if (pr === "pr_merge") return "observe-merge";
  if (report === "submit" || report === "resume") return report;
  return undefined;
}

/** Locate by the recorded pane, never by an arbitrary directory or a guessed kind. */
function worker(paths: OperatorPaths, registering = false): Result<Worker | null, Refusal> {
  const caller = z
    .object({ HERDR_SOCKET_PATH: z.string(), HERDR_PANE_ID: z.string() })
    .safeParse(Environment.read());
  if (!caller.success) return Ok(null);
  const { HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: paneId } = caller.data;
  const read = DeviceState.readReport(paths, { by: "pane", socket, paneId });
  // Registration is the only startup path that permits a device with no state yet.
  if (registering && read.tag === "Err" && read.error.reason === "state_missing") return Ok(null);
  if (read.tag === "Err" && read.error.reason === "worker_launch_not_found") return Ok(null);
  return read.map((value) => {
    const launch = value.launch;
    if (launch === null) return null;
    if (launch.kind === null) return null;
    const kind = WorkerKinds.snapshotSchema().parse(JSON.parse(launch.kind));
    return {
      source: { id: value.source.id, repository: value.source.repository },
      assignment: { key: value.assignment.key },
      launch,
      kind,
    };
  });
}

/** PR commands select by the validated Git worktree, even when another pane runs them. */
function worktreeWorker(
  paths: OperatorPaths,
  target: Extract<Awaited<ReturnType<typeof PullRequests.workerTarget>>, { tag: "Ok" }>["value"],
): Result<Worker | null, Refusal> {
  const read = DeviceState.readSources(paths, target.repository, target.sourceId);
  return read.flatMap((rows) => {
    const source = rows[0];
    if (source === undefined) return missingFacts();
    const launch = source.launches.find((row) => row.id === target.launchId);
    if (launch === undefined) return missingFacts();
    if (launch.kind === null) return Ok(null);
    return Ok({
      source: { id: target.sourceId, repository: target.repository },
      assignment: { key: target.assignment },
      launch,
      kind: WorkerKinds.snapshotSchema().parse(JSON.parse(launch.kind)),
    });
  });
}

function recorded(
  paths: OperatorPaths,
  selected: Worker,
  clean: boolean,
  head: string | null,
): Result<Facts, Refusal> {
  const read = DeviceState.readSources(paths, selected.source.repository, selected.source.id);
  return read.flatMap((rows) => {
    const source = rows[0];
    if (source === undefined) return missingFacts();
    const key = selected.assignment.key;
    const report = source.reports.findLast((row) => row.assignment === key);
    const pr = source.pullRequests.find((row) => row.assignment === key);
    const review = source.internalReviews.find((row) => row.assignment === key);
    const reviewEnded = review !== undefined && ["ready", "skipped"].includes(review.state);
    return Ok({
      kind: selected.kind,
      report:
        report === undefined
          ? null
          : {
              returned: report.decision === "returned",
              accepted: report.decision === "accepted",
              resumed: source.assignments.some((row) => row.key === key && row.state === "running"),
            },
      pr: {
        associated: pr !== undefined,
        rounds: source.internalReviewRounds.filter((row) => row.assignment === key).length,
        // A historical eligibleHead is not a current non-draft observation. #389 owns new evidence.
        ready: pr !== undefined && head !== null && review?.readyHead === head && reviewEnded,
        merged: pr !== undefined && pr.mergedAt !== null,
        parked: false,
      },
      internalReview: selected.launch.internalReview === true,
      reviewEnded,
      handedOff: review !== undefined && review.implementerLaunchId === selected.launch.id,
      worktreeClean: clean,
    });
  });
}

/** Commands and results share the same phase decision over the launch's immutable kind. */
async function withWorkerContext(args: string[], paths: OperatorPaths, run: () => Promise<void>) {
  let selection: Result<Worker | null, Refusal>;
  const event = eventOf(args);
  if (event !== undefined && event !== "submit" && event !== "resume") {
    const target = await PullRequests.workerTarget({ paths, cwd: process.cwd() });
    if (target.tag === "Ok") {
      selection = worktreeWorker(paths, target.value);
    } else {
      return phaseReadFailure(args, event, target);
    }
  } else selection = worker(paths, projectArgs(args)?.command === "register");
  if (selection.tag !== "Ok") return phaseReadFailure(args, event, selection);
  const selected = selection.value;
  if (selected === null) return run();
  const { clean, head } = await worktreeObservation(selected, event);
  const initial = recorded(paths, selected, clean, head);
  if (initial.tag !== "Ok") return phaseReadFailure(args, event, initial);
  return withOutputContext(
    () => {
      const facts = recorded(paths, selected, clean, head);
      if (facts.tag !== "Ok") return { failure: facts };
      const phase = WorkerKinds.decidePhase(facts.value);
      return { kind: phase.kind, phase: phase.phase, next: phase.next };
    },
    async () => {
      const phase = WorkerKinds.decidePhase(initial.value, event);
      if (phase.refusal !== undefined) {
        failure(
          `${args[0]}_${args[1]}`,
          phase.refusal.reason,
          phase.refusal.detail,
          exitCodeOf(phase.refusal.reason, pullRequestExitCodes),
          args.includes("--json"),
          { ...phase, state: phase.refusal.state },
        );
        return;
      }
      await run();
    },
  );
}

async function worktreeObservation(selected: Worker, event: Event | undefined) {
  let clean = true;
  let head: string | null = null;
  if (selected.launch.worktreePath !== null && event !== "observe-merge") {
    const status = await ToolInvocation.run({
      tool: "git",
      args: ["status", "--porcelain", "--untracked-files=normal"],
      cwd: selected.launch.worktreePath,
      timeoutMs: 10000,
    });
    clean = status.status === "completed" && status.exitCode === 0 && status.stdout === "";
    const commit = await ToolInvocation.run({
      tool: "git",
      args: ["rev-parse", "--verify", "HEAD"],
      cwd: selected.launch.worktreePath,
      timeoutMs: 10000,
    });
    head = commit.status === "completed" && commit.exitCode === 0 ? commit.stdout.trim() : null;
  }
  return { clean, head };
}

function phaseReadFailure(
  args: string[],
  event: Event | undefined,
  result: Exclude<Result<unknown, Refusal>, { tag: "Ok" }>,
) {
  respond({
    operation:
      pullRequestArgs(args)?.operation ?? `report_${reportArgs(args)?.command ?? "context"}`,
    result,
    exitCodes: pullRequestExitCodes,
    defect: event === "submit" || event === "resume" ? "report_defect" : "pr_defect",
    json: args.includes("--json"),
  });
}

export async function run(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const started = await startup(args, json);
  if (started === null) return;
  await withWorkerContext(args, started.paths, async () => {
    if (runUsage(args, started.release, json)) return;
    // One agent session coordinates a source, so another session's command changes nothing.
    if (await refuseUnsupervised(args, started.paths, json)) return;
    await withOwnChanges(args, started.paths, () => handle(args, started.paths, json));
  });
}

async function handle(args: string[], paths: OperatorPaths, json: boolean) {
  for (const handler of [
    async (input: string[], _paths: OperatorPaths, flag: boolean) => runLauncher(input, flag),
    runSkills,
    runReadiness,
    runProfiles,
    runSettings,
    runProject,
    runSources,
    runDispatch,
    runAsk,
    runPullRequests,
    runReports,
    runQuestions,
    runMessages,
    runObligations,
    runReviews,
  ]) {
    if (await handler(args, paths, json)) return;
  }
  invalidArguments(json, args);
}
