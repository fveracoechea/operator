import type { OperatorHome } from "../operator-home/main.ts";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { PullRequests } from "../pull-requests/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { z } from "zod";
import { failure, withOutputContext } from "./output.ts";
import { runProfiles } from "./profiles.ts";
import { runSkills } from "./skills.ts";
import { runLauncher } from "./launcher.ts";
import { runReadiness } from "./readiness.ts";
import { runSources } from "./sources.ts";
import { runDispatch } from "./dispatch.ts";
import { runAsk } from "./ask.ts";
import { pullRequestArgs, runPullRequests } from "./pull-requests.ts";
import { reportArgs, runReports } from "./reports.ts";
import { runQuestions } from "./questions.ts";
import { runMessages } from "./messages.ts";
import { runObligations } from "./obligations.ts";
import { runReviews } from "./reviews.ts";
import { runProject } from "./projects.ts";
import { runSettings } from "./settings.ts";
import { startup } from "./startup.ts";
import { withOwnChanges } from "./own-changes.ts";
import { refuseUnsupervised } from "./supervision.ts";
import { invalidArguments, runUsage } from "./usage.ts";

type OperatorPaths = ReturnType<typeof OperatorHome.resolve>;
type Facts = Parameters<typeof WorkerKinds.decidePhase>[0];
type Event = NonNullable<Parameters<typeof WorkerKinds.decidePhase>[1]>;

function eventOf(args: string[]): Event | undefined {
  const pr = pullRequestArgs(args)?.operation;
  const report = reportArgs(args)?.command;
  if (pr === "pr_associate") return "associate";
  if (pr === "pr_round") return "round";
  if (pr === "pr_ready") return "ready";
  if (pr === "pr_wait") return "wait";
  if (pr === "pr_merge") return "merge";
  if (report === "submit" || report === "resume") return report;
  return undefined;
}

/** Locate by the recorded pane, never by an arbitrary directory or a guessed kind. */
function worker(paths: OperatorPaths) {
  const { HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: paneId } = Environment.read();
  if (socket === undefined || paneId === undefined) return null;
  const read = DeviceState.readReport(paths, { by: "pane", socket, paneId });
  if (read.tag !== "Ok") return null;
  const launch = read.value.launch;
  if (launch === null) return null;
  if (launch.kind === null) return null;
  const kind = WorkerKinds.snapshotSchema().parse(JSON.parse(launch.kind));
  return {
    source: { id: read.value.source.id, repository: read.value.source.repository },
    assignment: { key: read.value.assignment.key },
    launch,
    kind,
  };
}

/** PR commands select by the validated Git worktree, even when another pane runs them. */
function worktreeWorker(
  paths: OperatorPaths,
  target: Extract<Awaited<ReturnType<typeof PullRequests.workerTarget>>, { tag: "Ok" }>["value"],
) {
  const read = DeviceState.readSources(paths, target.repository, target.sourceId);
  if (read.tag !== "Ok") return null;
  const source = read.value[0];
  if (source === undefined) return null;
  const launch = source.launches.find((row) => row.id === target.launchId);
  if (launch === undefined) return null;
  if (launch.kind === null) return null;
  return {
    source: { id: target.sourceId, repository: target.repository },
    assignment: { key: target.assignment },
    launch,
    kind: WorkerKinds.snapshotSchema().parse(JSON.parse(launch.kind)),
  };
}

function recorded(
  paths: OperatorPaths,
  selected: NonNullable<ReturnType<typeof worker>>,
  clean: boolean,
  head: string | null,
): Facts | null {
  const read = DeviceState.readSources(paths, selected.source.repository, selected.source.id);
  if (read.tag !== "Ok") return null;
  const source = read.value[0];
  if (source === undefined) return null;
  const key = selected.assignment.key;
  const report = source.reports.findLast((row) => row.assignment === key);
  const pr = source.pullRequests.find((row) => row.assignment === key);
  const review = source.internalReviews.find((row) => row.assignment === key);
  const reviewEnded = review !== undefined && ["ready", "skipped"].includes(review.state);
  const eligibleHead =
    pr === undefined
      ? null
      : z.object({ eligibleHead: z.string().nullable() }).parse(JSON.parse(pr.progress))
          .eligibleHead;
  return {
    kind: selected.kind,
    report:
      report === undefined
        ? null
        : {
            returned: report.decision === "returned",
            accepted: report.decision === "accepted",
            resumed: source.assignments.find((row) => row.key === key)?.state === "running",
          },
    pr: {
      associated: pr !== undefined,
      rounds: source.internalReviewRounds.filter((row) => row.assignment === key).length,
      // Until explicit ready transitions land, only same-head recorded evidence proves readiness.
      ready:
        head !== null && ((review?.readyHead === head && reviewEnded) || eligibleHead === head),
      merged: pr !== undefined && pr.mergedAt !== null,
      parked: false,
    },
    internalReview: selected.launch.internalReview === true,
    reviewEnded,
    handedOff: review !== undefined && review.implementerLaunchId === selected.launch.id,
    worktreeClean: clean,
  };
}

/** Commands and results share the same phase decision over the launch's immutable kind. */
async function withWorkerContext(args: string[], paths: OperatorPaths, run: () => Promise<void>) {
  let selected = worker(paths);
  if (selected === null) return run();
  let event = eventOf(args);
  if (event !== undefined && event !== "submit" && event !== "resume") {
    const target = await PullRequests.workerTarget({ paths, cwd: process.cwd() });
    if (target.tag === "Ok") {
      selected = worktreeWorker(paths, target.value);
      if (selected === null) return run();
    } else {
      // The command owner reports its canonical ownership refusal, not a phase refusal.
      event = undefined;
    }
  }
  let clean = true;
  let head: string | null = null;
  if (selected.launch.worktreePath !== null) {
    const status = await ToolInvocation.run({
      tool: "git",
      args: ["status", "--porcelain"],
      cwd: selected.launch.worktreePath,
      timeoutMs: 10000,
    });
    clean = status.status === "completed" && status.exitCode === 0 && status.stdout.trim() === "";
    const commit = await ToolInvocation.run({
      tool: "git",
      args: ["rev-parse", "--verify", "HEAD"],
      cwd: selected.launch.worktreePath,
      timeoutMs: 10000,
    });
    head = commit.status === "completed" && commit.exitCode === 0 ? commit.stdout.trim() : null;
  }
  const initial = recorded(paths, selected, clean, head);
  if (initial === null) return run();
  return withOutputContext(
    () => {
      const phase = WorkerKinds.decidePhase(recorded(paths, selected, clean, head) ?? initial);
      return {
        kind: phase.kind,
        phase: phase.phase,
        next: phase.next,
      };
    },
    async () => {
      const phase = WorkerKinds.decidePhase(initial, event);
      if (phase.refusal !== undefined) {
        failure(
          `${args[0]}_${args[1]}`,
          phase.refusal.reason,
          phase.refusal.detail,
          4,
          args.includes("--json"),
          { ...phase, state: phase.refusal.state },
        );
        return;
      }
      await run();
    },
  );
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
  invalidArguments(json);
}
