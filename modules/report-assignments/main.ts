// Bun has no lstat, copy, folder creation, rename, or recursive removal API.
import { isCodedError } from "../../lib/coded-error.ts";
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
import { renderReport, submissionSchema, type Submission } from "./content.ts";

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
};
type Decision = { paths: Paths; target: Target; command: Command };

function qualify<T>(cause: Error, defect: (cause: Error) => T) {
  if (cause instanceof SyntaxError || cause instanceof z.ZodError)
    return { reason: "invalid_report_input", detail: `${cause.message} Nothing changed.` };
  if (
    isCodedError(cause) &&
    ["ENOENT", "EACCES", "EPERM", "EIO", "EROFS", "ENOSPC", "ENOTDIR", "EISDIR", "ELOOP"].includes(
      cause.code,
    )
  )
    return { reason: "report_io_failed", detail: String(cause) };
  return defect(cause);
}

/** Carry an earlier step's refusal or defect into the command result. Its callback never runs. */
function stop(result: Result<unknown, Failure>): Result<never, Failure> {
  return result.flatMap(() =>
    Err<Failure>({ reason: "report_defect", detail: "A successful step cannot stop a command." }),
  );
}

/** The pane that runs a command. A worker's pane identifies its assignment. */
function caller() {
  const environment = Environment.read();
  return {
    socket: environment.HERDR_SOCKET_PATH ?? null,
    paneId: environment.HERDR_PANE_ID ?? null,
  };
}

function decide(facts: Facts, command: Command) {
  return WorkSources.decideReport({
    command,
    assignment: facts.assignment,
    assignments: facts.assignments,
    launch: facts.launch,
    latest: facts.reports.at(-1) ?? null,
    caller: caller(),
  });
}

/** Refuse from the facts before any file is written. */
function read(decision: Decision) {
  return DeviceState.readReport(decision.paths, decision.target).flatMap((facts) =>
    decide(facts, decision.command).map((decided) => ({ facts, decided })),
  );
}

/** The rule runs again on the facts that the write transaction reads, and must agree. */
function record(
  decision: Decision,
  expected: Decided,
  fields: (facts: Facts, decided: Decided) => Fields,
) {
  return DeviceState.changeReport(decision.paths, decision.target, (facts) =>
    decide(facts, decision.command).flatMap((decided) => {
      if (JSON.stringify(decided) !== JSON.stringify(expected))
        return Err<Failure>({
          reason: "report_changed",
          detail:
            "The assignment changed during this command. Read operator next. Nothing changed.",
        });
      const { insert, update } = fields(facts, decided);
      const number = "insert" in decided.report ? decided.report.insert : decided.report.update;
      return Ok({
        insert,
        update: update === undefined ? undefined : { ...update, number },
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
  return Projects.current(input).map(({ data }): Target => ({
    by: "key",
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
    await Bun.write(`${staged}/${name}`, "", { createPath: true });
    await copyFile(file, `${staged}/${name}`);
    stored.push(`${directory}/${name}`);
  }
  await Bun.write(
    `${staged}/report.md`,
    renderReport({ number: input.number, assignment: input.key, submission, files: stored }),
    { createPath: true },
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
      const number = "insert" in decided.report ? decided.report.insert : 0;
      const directory = `${assignmentFiles(input.paths, facts).reports}/${number}`;
      const staged = pending(input.paths, facts);
      const stored = await stageReport({
        staged,
        directory,
        number,
        key: facts.assignment.key,
        submission,
      });
      if (stored.tag !== "Ok") {
        await rm(staged, { recursive: true, force: true });
        return stop(stored);
      }
      const recorded = record(decision, decided, (current) => ({
        insert: {
          sourceId: current.source.id,
          assignment: current.assignment.key,
          number,
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
        await rm(staged, { recursive: true, force: true });
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
      const number = facts.reports.at(-1)?.number ?? 0;
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
      const number = facts.reports.at(-1)?.number ?? 0;
      const followUp = `${assignmentFiles(input.paths, facts).followUps}/${number}.md`;
      const staged = `${pending(input.paths, facts)}.md`;
      await Bun.write(staged, `${text}\n`, { createPath: true });
      const recorded = record(decision, decided, () => ({
        update: { decision: "returned", decidedAt: new Date().toISOString(), followUp: text },
      }));
      if (recorded.tag !== "Ok") {
        await rm(staged, { force: true });
        return stop(recorded);
      }
      await publish(staged, followUp);
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

/** Acceptance permits closing the worker pane. It never removes unlanded work. */
async function cleanup(checkout: string, facts: Facts) {
  const steps: string[] = [];
  const launch = facts.launch;
  if (launch !== null && launch.paneId !== null && ["running", "finished"].includes(launch.state)) {
    // Herdr reads its server from the environment, and another server can reuse a pane id.
    if (caller().socket !== launch.herdrSocket)
      return {
        state: "failed" as const,
        detail: `Pane ${launch.paneId} belongs to another Herdr server. Repeat report accept in a pane of that server.`,
      };
    // The unique launch name proves that the recorded pane still holds this worker.
    const agents = await Herdr.agentNames();
    if (agents.tag !== "Ok")
      return {
        state: "failed" as const,
        detail: agents.tag === "Err" ? agents.error.detail : String(agents.cause),
      };
    if (agents.value.includes(launch.name)) {
      const closed = await Herdr.closePane(launch.paneId);
      if (closed.tag !== "Ok")
        return {
          state: "failed" as const,
          detail: closed.tag === "Err" ? closed.error.detail : String(closed.cause),
        };
      steps.push(`Closed pane ${launch.paneId}.`);
    } else steps.push(`Pane ${launch.paneId} no longer holds ${launch.name}.`);
  }
  if (launch?.worktreePath) {
    let outcome;
    try {
      outcome = await WorkerDispatch.cleanWorktree({
        checkout,
        worktree: launch.worktreePath,
        branch: launch.branch,
      });
    } catch (cause) {
      return { state: "failed" as const, detail: String(cause) };
    }
    steps.push(outcome.detail);
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
      const checkout = target.value.by === "key" ? target.value.checkout : "";
      const outcome = await cleanup(checkout, facts);
      const cleaned = DeviceState.changeReport(input.paths, decision.target, (current) =>
        decide(current, "cleanup").map((done) => ({
          update: {
            number: "insert" in done.report ? done.report.insert : done.report.update,
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
  return(input: { paths: Paths; cwd: string; sourceId: string; assignment: string; file: string }) {
    return returnReport(input);
  },
};
