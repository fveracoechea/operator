// Bun has no lstat, copy, folder creation, rename, or recursive removal API.
import { copyFile, lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Err, Ok, fromPromise, type Result } from "unthrown";
import { z } from "zod";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { WorkerDispatch } from "../worker-dispatch/main.ts";
import { WorkerQuestions } from "../worker-questions/main.ts";
import { realPathOrNull } from "../../lib/real-path.ts";
import { renderReport, submissionSchema, type Submission } from "./content.ts";
import { qualify } from "./failures.ts";

type Paths = ReturnType<typeof OperatorHome.resolve>;
type Failure = { reason: string; detail: string };
type Target = Parameters<typeof DeviceState.readReport>[1];
type Facts = Extract<ReturnType<typeof DeviceState.readReport>, { tag: "Ok" }>["value"];
type Decided = Extract<ReturnType<typeof WorkSources.decideReport>, { tag: "Ok" }>["value"];
type Command = Parameters<typeof WorkSources.decideReport>[0]["command"];
type ReportRow = Facts["reports"][number];
type Fields = {
  insert?: ReportRow;
  update?: Partial<Omit<ReportRow, "sourceId" | "assignment" | "number">>;
  promote?: Extract<
    ReturnType<Parameters<typeof DeviceState.changeReport>[2]>,
    { tag: "Ok" }
  >["value"]["promote"];
};
/** A promotion names the PR assignment that it adds. ADR-0023. */
type Decision = { paths: Paths; target: Target; command: Command; promote?: string };

/** Carry an earlier step's refusal or defect into the command result. Its callback never runs. */
function stop(result: Result<unknown, Failure>): Result<never, Failure> {
  // Stryker disable next-line ArrowFunction: equivalent: the callback runs only for a success, and no caller stops a success
  return result.flatMap(() => stop(result));
}

/** The pane that runs a command. A worker's pane identifies its assignment. */
function caller() {
  const environment = Environment.read();
  return {
    socket: environment.HERDR_SOCKET_PATH ?? null,
    paneId: environment.HERDR_PANE_ID ?? null,
  };
}

/** The number of the report that a decision inserts or updates. */
function reportNumber(report: Decided["report"]) {
  return "insert" in report ? report.insert : report.update;
}

function decide(facts: Facts, command: Command, promote?: string) {
  return WorkSources.decideReport({
    command,
    assignment: facts.assignment,
    assignments: facts.assignments,
    launch: facts.launch,
    latest: facts.reports.at(-1) ?? null,
    caller: caller(),
    promotion:
      promote === undefined ? undefined : { sourceState: facts.source.state, key: promote },
  });
}

/** Refuse from the facts before any file is written. */
function read(decision: Decision) {
  return DeviceState.readReport(decision.paths, decision.target).flatMap((facts) =>
    decide(facts, decision.command, decision.promote).map((decided) => ({ facts, decided })),
  );
}

/** The rule runs again on the facts that the write transaction reads, and must agree. */
function record(
  decision: Decision,
  expected: Decided,
  fields: (facts: Facts, decided: Decided) => Fields,
) {
  return DeviceState.changeReport(decision.paths, decision.target, (facts) =>
    decide(facts, decision.command, decision.promote).flatMap((decided) => {
      if (JSON.stringify(decided) !== JSON.stringify(expected))
        return Err<Failure>({
          reason: "report_changed",
          detail:
            "The assignment changed during this command. Read operator next. Nothing changed.",
        });
      const { insert, update, promote } = fields(facts, decided);
      return Ok({
        insert,
        promote,
        update:
          update === undefined ? undefined : { ...update, number: reportNumber(decided.report) },
        assignmentState: decided.assignmentState,
        source: decided.sourceFinished
          ? { state: "finished", endedAt: new Date().toISOString() }
          : undefined,
        finishLaunch: decided.finishLaunch,
      });
    }),
  );
}

function assignmentFiles(paths: Paths, facts: Facts) {
  return OperatorHome.assignmentFiles(paths, {
    repository: facts.source.repository,
    sourceId: facts.source.id,
    assignment: facts.assignment.key,
  });
}

function workerPane(): Result<Target, Failure> {
  const { socket, paneId } = caller();
  return socket === null || paneId === null
    ? Err({
        reason: "worker_pane_required",
        detail:
          "Run this command in the Herdr pane that Operator dispatched for the assignment. Nothing changed.",
      })
    : Ok({ by: "pane", socket, paneId });
}

function superAgentTarget(input: {
  paths: Paths;
  cwd: string;
  sourceId: string;
  assignment: string;
}) {
  return Projects.current(input).map(({ data }) => ({
    by: "key" as const,
    repository: data.repository,
    checkout: data.checkout,
    sourceId: input.sourceId,
    assignment: input.assignment,
  }));
}

/**
 * A command stages its files in the assignment's private pending folder, which no brief lists.
 * Only a recorded command publishes them, so a refused command never changes a recorded file.
 */
function pending(paths: Paths, facts: Facts) {
  return `${assignmentFiles(paths, facts).directory}/pending/${crypto.randomUUID()}`;
}

async function publish(staged: string, destination: string) {
  await mkdir(path.dirname(destination), { recursive: true });
  // A destination of a recorded number can only remain from a publish that did not finish.
  await rm(destination, { recursive: true, force: true });
  await rename(staged, destination);
}

/** Supporting files are copied, so a later change to a draft cannot change the report. */
async function stageReport(input: {
  staged: string;
  directory: string;
  number: number;
  key: string;
  submission: Submission;
}) {
  const { staged, directory, submission } = input;
  for (const file of submission.files)
    if (!(await lstat(file)).isFile())
      return Err<Failure>({
        reason: "invalid_report_input",
        detail: `Supporting file ${file} is not a regular file. Nothing changed.`,
      });
  const stored: string[] = [];
  for (const file of submission.files) {
    const name = `files/${path.basename(file)}`;
    await mkdir(`${staged}/files`, { recursive: true });
    await copyFile(file, `${staged}/${name}`);
    stored.push(`${directory}/${name}`);
  }
  await Bun.write(
    `${staged}/report.md`,
    renderReport({ number: input.number, assignment: input.key, submission, files: stored }),
  );
  return Ok(stored);
}

function submit(input: { paths: Paths; file: string }) {
  return fromPromise(
    async () => {
      const target = workerPane();
      if (target.tag !== "Ok") return stop(target);
      const decision = { paths: input.paths, target: target.value, command: "submit" as const };
      const submission = submissionSchema.parse(JSON.parse(await Bun.file(input.file).text()));
      const before = read(decision);
      if (before.tag !== "Ok") return stop(before);
      const { facts, decided } = before.value;
      const number = reportNumber(decided.report);
      const directory = `${assignmentFiles(input.paths, facts).reports}/${number}`;
      const staged = pending(input.paths, facts);
      const stored = await stageReport({
        staged,
        directory,
        number,
        key: facts.assignment.key,
        submission,
      });
      if (stored.tag !== "Ok") return stop(stored);
      const recorded = record(decision, decided, (current) => ({
        insert: {
          sourceId: current.source.id,
          assignment: current.assignment.key,
          number,
          // Stryker disable next-line OptionalChaining, StringLiteral: equivalent: submission needs a running launch, so the launch is never null here
          launchId: current.launch?.id ?? "",
          submittedAt: new Date().toISOString(),
          conclusion: submission.conclusion,
          evidence: JSON.stringify(submission.evidence),
          unresolved: JSON.stringify(submission.unresolved),
          decisions: JSON.stringify(submission.decisions),
          files: JSON.stringify(stored.value),
          decision: null,
          decidedAt: null,
          followUp: null,
          cleanupState: null,
          cleanupDetail: null,
        },
      }));
      if (recorded.tag !== "Ok") {
        await rm(staged, { recursive: true });
        return stop(recorded);
      }
      await publish(staged, directory);
      return Ok({
        reason: "report_submitted",
        data: {
          sourceId: facts.source.id,
          assignment: facts.assignment.key,
          state: "reported",
          report: number,
          file: `${directory}/report.md`,
          files: stored.value,
        },
      });
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

function resume(input: { paths: Paths }) {
  return fromPromise(
    async () => {
      const target = workerPane();
      if (target.tag !== "Ok") return stop(target);
      const decision = { paths: input.paths, target: target.value, command: "resume" as const };
      const before = read(decision);
      if (before.tag !== "Ok") return stop(before);
      const { facts, decided } = before.value;
      const recorded = record(decision, decided, () => ({}));
      if (recorded.tag !== "Ok") return stop(recorded);
      const number = reportNumber(decided.report);
      return Ok({
        reason: "report_resumed",
        data: {
          sourceId: facts.source.id,
          assignment: facts.assignment.key,
          state: "running",
          followUp: `${assignmentFiles(input.paths, facts).followUps}/${number}.md`,
        },
      });
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

function returnReport(input: {
  paths: Paths;
  cwd: string;
  sourceId: string;
  assignment: string;
  file: string;
}) {
  return fromPromise(
    async () => {
      const target = await superAgentTarget(input);
      if (target.tag !== "Ok") return stop(target);
      const decision = { paths: input.paths, target: target.value, command: "return" as const };
      const text = z
        .string()
        .trim()
        .min(1)
        .parse(await Bun.file(input.file).text());
      const before = read(decision);
      if (before.tag !== "Ok") return stop(before);
      const { facts, decided } = before.value;
      const number = reportNumber(decided.report);
      const followUp = `${assignmentFiles(input.paths, facts).followUps}/${number}.md`;
      const staged = `${pending(input.paths, facts)}.md`;
      await Bun.write(staged, `${text}\n`);
      const recorded = record(decision, decided, () => ({
        update: { decision: "returned", decidedAt: new Date().toISOString(), followUp: text },
      }));
      if (recorded.tag !== "Ok") {
        await rm(staged);
        return stop(recorded);
      }
      await publish(staged, followUp);
      // Stryker disable next-line OptionalChaining: equivalent: a submitted report always has the launch that submitted it
      const running = facts.launch?.state === "running";
      return Ok({
        reason: "report_returned",
        data: {
          sourceId: facts.source.id,
          assignment: facts.assignment.key,
          report: number,
          followUp,
          // A live worker resumes with the follow-up. A stopped worker needs a replacement.
          next: running ? "resume_worker" : "replace_worker",
        },
      });
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

async function disposeWorktree(
  paths: Paths,
  checkout: string,
  target: { worktree: string; branch: string | null },
) {
  try {
    return await WorkerDispatch.cleanWorktree({ paths, checkout, ...target });
  } catch (cause) {
    return { state: "failed" as const, detail: String(cause) };
  }
}

/** The unique launch name proves that the recorded pane still holds this worker. */
async function closeWorkerPane(launch: {
  paneId: string;
  herdrSocket: string | null;
  name: string;
}) {
  // Herdr reads its server from the environment, and another server can reuse a pane id.
  if (caller().socket !== launch.herdrSocket)
    return {
      state: "failed" as const,
      detail: `Pane ${launch.paneId} belongs to another Herdr server. Repeat report accept in a pane of that server.`,
    };
  const agents = await Herdr.agentNames();
  if (agents.tag !== "Ok")
    return {
      state: "failed" as const,
      detail: agents.tag === "Err" ? agents.error.detail : String(agents.cause),
    };
  if (!agents.value.includes(launch.name))
    return {
      state: "done" as const,
      detail: `Pane ${launch.paneId} no longer holds ${launch.name}.`,
    };
  const closed = await Herdr.closePane(launch.paneId);
  if (closed.tag !== "Ok")
    return {
      state: "failed" as const,
      detail: closed.tag === "Err" ? closed.error.detail : String(closed.cause),
    };
  return { state: "done" as const, detail: `Closed pane ${launch.paneId}.` };
}

/** Acceptance permits closing the worker pane. It never removes unlanded work. */
async function cleanup(paths: Paths, checkout: string, facts: Facts) {
  const steps: string[] = [];
  const launch = facts.launch;
  if (launch !== null && launch.paneId !== null && ["running", "finished"].includes(launch.state)) {
    const pane = await closeWorkerPane({ ...launch, paneId: launch.paneId });
    if (pane.state === "failed") return pane;
    steps.push(pane.detail);
  }
  if (launch?.worktreePath) {
    const worktree = await disposeWorktree(paths, checkout, {
      worktree: launch.worktreePath,
      branch: launch.branch,
    });
    if (worktree.state === "failed") return worktree;
    steps.push(worktree.detail);
    // Only the person can authorize the deletion of unlanded work, so it stays in next.
    if (worktree.state === "kept") return { state: "kept" as const, detail: steps.join(" ") };
  }
  return { state: "done" as const, detail: steps.join(" ") || "No pane or worktree to clean up." };
}

/** The decoded record carries the unresolved points and the reference that inspection shows. */
function acceptedReport(input: {
  paths: Paths;
  cwd: string;
  sourceId: string;
  assignment: string;
}) {
  return WorkSources.show(input).flatMap((source) => {
    const report = source?.reports.findLast((row) => row.assignment === input.assignment);
    return report === undefined
      ? Err<Failure>({ reason: "report_defect", detail: "The accepted report is not recorded." })
      : Ok(report);
  });
}

function accept(input: { paths: Paths; cwd: string; sourceId: string; assignment: string }) {
  return fromPromise(
    async () => {
      const target = await superAgentTarget(input);
      if (target.tag !== "Ok") return stop(target);
      const decision = { paths: input.paths, target: target.value, command: "accept" as const };
      const before = read(decision);
      if (before.tag !== "Ok") return stop(before);
      const { facts, decided } = before.value;
      const recorded = record(decision, decided, (_facts, current) => ({
        update: current.retry
          ? { cleanupState: "pending" }
          : { decision: "accepted", decidedAt: new Date().toISOString(), cleanupState: "pending" },
      }));
      if (recorded.tag !== "Ok") return stop(recorded);
      const outcome = await cleanup(input.paths, target.value.checkout, facts);
      const cleaned = DeviceState.changeReport(input.paths, decision.target, (current) =>
        decide(current, "cleanup").map((done) => ({
          update: {
            number: reportNumber(done.report),
            cleanupState: outcome.state,
            cleanupDetail: outcome.detail,
          },
        })),
      );
      if (cleaned.tag !== "Ok") return stop(cleaned);
      const report = await acceptedReport(input);
      if (report.tag !== "Ok") return stop(report);
      const { number, conclusion, unresolved, reference } = report.value;
      const files = assignmentFiles(input.paths, facts);
      return Ok({
        reason: decided.retry ? "report_cleanup_retried" : "report_accepted",
        data: {
          sourceId: facts.source.id,
          assignment: facts.assignment.key,
          state: "completed",
          sourceFinished: decided.sourceFinished === true,
          report: number,
          conclusion,
          unresolved,
          file: `${files.reports}/${number}/report.md`,
          // Another project's SuperAgent copies the content it needs with this reference.
          reference,
          cleanup: outcome,
        },
      });
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

/** The PR assignment's launch that takes over the running report worker's pane and worktree. */
function handoverLaunch(
  launch: NonNullable<Facts["launch"]>,
  change: { key: string; name: string; branch: string; at: string },
) {
  return {
    ...launch,
    id: crypto.randomUUID(),
    assignment: change.key,
    attempt: 1,
    state: "running",
    name: change.name,
    resources: "worktree",
    branch: change.branch,
    startedAt: change.at,
    endedAt: null,
    failureReason: null,
    failureDetail: null,
    // No observation since the handover. The worker reads its brief from a steering message.
    activity: null,
    activityAt: null,
    ownerPid: null,
    leaseAt: null,
  };
}

/**
 * Rewrite the kept worker's brief from the PR template, then tell the worker to read it in a
 * recorded steering message. A stopped worker gets its brief at dispatch. ADR-0022 and ADR-0023.
 */
async function steerKeptWorker(request: PromoteInput, kept: boolean) {
  if (!kept) return Ok({ brief: null, message: null });
  const brief = await WorkerDispatch.refreshBrief(request);
  if (brief.tag !== "Ok") return stop(brief);
  return WorkerQuestions.steer({
    ...request,
    key: "promoted",
    message: `The SuperAgent promoted your report into the PR assignment ${request.assignment}, which you now own. Read your new brief at ${brief.value} and follow it.`,
  }).map(({ data }) => ({ brief: brief.value, message: data }));
}

type PromoteInput = {
  paths: Paths;
  cwd: string;
  sourceId: string;
  assignment: string;
  file: string;
};

/** The supplied PR assignment and the report facts, refused before any rename. */
async function promotionFacts(input: PromoteInput) {
  const target = await superAgentTarget(input);
  if (target.tag !== "Ok") return stop(target);
  const supplied = await WorkSources.readPromotion(input.file);
  if (supplied.tag !== "Ok") return stop(supplied);
  const planned = supplied.value;
  const decision = {
    paths: input.paths,
    target: target.value,
    command: "promote" as const,
    promote: planned.key,
  };
  const before = read(decision);
  if (before.tag !== "Ok") return stop(before);
  const { facts, decided } = before.value;
  const recorded = facts.launch;
  const worktreePath = recorded?.worktreePath ?? null;
  // The rule refused a report without a worktree, so the launch has one.
  // Stryker disable next-line ConditionalExpression: equivalent: the promote rule refuses a missing launch or worktree first
  if (recorded === null || worktreePath === null)
    return Err<Failure>({ reason: "report_defect", detail: "The worktree is not recorded." });
  if ((await realPathOrNull(worktreePath)) === null)
    return Err<Failure>({
      reason: "promotion_worktree_missing",
      detail: `The worktree ${worktreePath} of ${facts.assignment.key} no longer exists. Nothing changed.`,
    });
  return Ok({
    checkout: target.value.checkout,
    planned,
    decision,
    facts,
    decided,
    launch: { ...recorded, worktreePath },
  });
}

/**
 * Accept the report and add one PR assignment that takes over its worktree and, while it runs,
 * its worker. The pane and the worktree stay, because the PR assignment owns them. ADR-0023.
 */
function promote(input: PromoteInput) {
  return fromPromise(
    async () => {
      const prepared = await promotionFacts(input);
      if (prepared.tag !== "Ok") return stop(prepared);
      const { checkout, planned, decision, facts, decided, launch } = prepared.value;
      const handover = await WorkerDispatch.handOver({
        paths: input.paths,
        checkout,
        callerSocket: caller().socket,
        assignment: planned,
        launch,
      });
      if (handover.tag !== "Ok") return stop(handover);
      const { name, branch } = handover.value;
      const at = new Date().toISOString();
      const taken =
        name === null ? null : handoverLaunch(launch, { key: planned.key, name, branch, at });
      const state = taken === null ? "ready" : "running";
      const recorded = record(decision, decided, (current) => ({
        update: {
          decision: "accepted",
          decidedAt: at,
          cleanupState: "done",
          cleanupDetail: `Promoted to ${planned.key}, which keeps the pane and the worktree.`,
        },
        promote: {
          assignment: {
            sourceId: current.source.id,
            key: planned.key,
            completion: "pr",
            state,
          },
          promotion: {
            sourceId: current.source.id,
            assignment: planned.key,
            report: current.assignment.key,
            reportNumber: reportNumber(decided.report),
            trackerKey: planned.trackerKey,
            instructions: planned.instructions,
            branch,
            internalReview: planned.internalReview ?? null,
            worktreePath: launch.worktreePath,
            handoverLaunchId: taken?.id ?? null,
            promotedAt: at,
          },
          launch: taken,
        },
      }));
      if (recorded.tag !== "Ok") {
        const undone = await handover.value.undo(recorded);
        return stop(undone.tag === "Ok" ? recorded : undone);
      }
      const kept = await steerKeptWorker({ ...input, assignment: planned.key }, taken !== null);
      if (kept.tag !== "Ok") return stop(kept);
      const report = await acceptedReport(input);
      if (report.tag !== "Ok") return stop(report);
      const { number, conclusion, unresolved, reference } = report.value;
      return Ok({
        reason: "report_promoted",
        data: {
          sourceId: facts.source.id,
          assignment: facts.assignment.key,
          state: "completed",
          report: number,
          conclusion,
          unresolved,
          file: `${assignmentFiles(input.paths, facts).reports}/${number}/report.md`,
          reference,
          promoted: {
            assignment: planned.key,
            state,
            branch,
            worktreePath: launch.worktreePath,
            name,
            brief: kept.value.brief,
          },
          message: kept.value.message,
          // A kept worker reads its new brief from the message. A stopped one needs a dispatch.
          next: taken === null ? "dispatch" : "wait",
        },
      });
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

/** Report assignments: worker submission and resume, and SuperAgent acceptance or return. */
export const ReportAssignments = {
  submit(input: { paths: Paths; file: string }) {
    return submit(input);
  },
  resume(input: { paths: Paths }) {
    return resume(input);
  },
  accept(input: { paths: Paths; cwd: string; sourceId: string; assignment: string }) {
    return accept(input);
  },
  /** Accept the report and promote it into the PR assignment that the file supplies. */
  promote(input: {
    paths: Paths;
    cwd: string;
    sourceId: string;
    assignment: string;
    file: string;
  }) {
    return promote(input);
  },
  return(input: { paths: Paths; cwd: string; sourceId: string; assignment: string; file: string }) {
    return returnReport(input);
  },
};
