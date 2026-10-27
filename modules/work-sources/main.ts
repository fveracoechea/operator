import { fromPromise, fromThrowable, Ok, Err } from "unthrown";
import { z } from "zod";
import { DeviceState } from "../device-state/main.ts";
import { Projects } from "../projects/main.ts";
import { DeviceSettings } from "../device-settings/main.ts";
import { planSchema } from "./plan.ts";
import { assignmentStateSchema, decideAssignment } from "./assignment-machine.ts";
import { decideSource } from "./source-machine.ts";
import {
  decodeSource,
  type Cleanup,
  type Launch,
  type PullRequest,
  type Report,
} from "./snapshot.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { decideReport } from "./report-machine.ts";

type Input = { paths: ReturnType<typeof OperatorHome.resolve>; cwd: string };

function qualify<T>(cause: unknown, defect: (cause: unknown) => T) {
  if (cause instanceof SyntaxError || cause instanceof z.ZodError)
    return { reason: "invalid_source_plan" as const, detail: cause.message };
  if (
    cause instanceof Error &&
    "code" in cause &&
    ["ENOENT", "EACCES", "EPERM", "EISDIR", "EIO", "ENOTDIR"].includes(String(cause.code))
  )
    return { reason: "source_io_failed" as const, detail: String(cause) };
  return defect(cause);
}

// Activity is shown as an observation only. It never proves a submitted or completed result.
function launchSummary(launch: Launch) {
  return {
    attempt: launch.attempt,
    state: launch.state,
    name: launch.name,
    paneId: launch.paneId,
    worktreePath: launch.worktreePath,
    branch: launch.branch,
    failure:
      launch.failureReason === null
        ? null
        : { reason: launch.failureReason, detail: launch.failureDetail },
    observedActivity:
      launch.activity === null ? null : { state: launch.activity, at: launch.activityAt },
  };
}

function pullRequestSummary(pr: PullRequest) {
  return {
    number: pr.number,
    url: pr.url,
    branch: pr.branch,
    wait: pr.waitStopped ? "stopped" : pr.waitState,
    waitAt: pr.waitAt,
    stack: pr.relay,
  };
}

/** The durable name of a report. Another project's SuperAgent copies content with it. */
function reportReference(repository: string, sourceId: string, report: Report) {
  return `operator:${repository}/sources/${sourceId}/assignments/${report.assignment}/reports/${report.number}`;
}

// The SuperAgent reads the short conclusion and gaps here and opens the report file only when it decides.
function reportSummary(input: Input, repository: string, sourceId: string, report: Report) {
  const files = OperatorHome.assignmentFiles(input.paths, {
    repository,
    sourceId,
    assignment: report.assignment,
  });
  return {
    number: report.number,
    conclusion: report.conclusion,
    unresolved: report.unresolved,
    reference: reportReference(repository, sourceId, report),
    file: `${files.reports}/${report.number}/report.md`,
    decision: report.decision,
    followUp: report.decision === "returned" ? `${files.followUps}/${report.number}.md` : null,
    cleanup:
      report.cleanupState === null
        ? null
        : { state: report.cleanupState, detail: report.cleanupDetail },
  };
}

function cleanupSummary(cleanup: Cleanup) {
  return {
    step: cleanup.step,
    state: cleanup.running ? "running" : cleanup.state,
    failure: cleanup.reason === null ? null : { reason: cleanup.reason, detail: cleanup.detail },
    updatedAt: cleanup.updatedAt,
  };
}

function cleanupFact(cleanup: Cleanup | undefined) {
  if (cleanup === undefined) return undefined;
  if (cleanup.running) return "running";
  if (cleanup.state !== "blocked") return cleanup.state;
  return cleanup.reason === "cleanup_resource_mismatch" ? "resource_mismatch" : "unlanded_work";
}

function read(input: Input & { sourceId?: string }) {
  return Projects.current(input)
    .flatMap(({ data }) => DeviceState.readSources(input.paths, data.repository, input.sourceId))
    .flatMap((rows) =>
      fromThrowable(
        () => rows.map(decodeSource),
        (cause, defect) =>
          cause instanceof z.ZodError || cause instanceof SyntaxError
            ? {
                reason: "state_corrupt" as const,
                detail: "Stored source records are invalid. They were not repaired.",
              }
            : defect(cause),
      )(),
    );
}

/** Plans are supplied by the SuperAgent. No operation reads or updates a tracker. */
export const WorkSources = {
  register(input: Input & { file: string }) {
    return fromPromise(async () => planSchema.parse(await Bun.file(input.file).json()), qualify)
      .flatMap((plan) =>
        DeviceSettings.show(input.paths).flatMap(({ data: settings }) => {
          const missing = plan.assignments.find(
            (assignment) =>
              assignment.profile !== undefined &&
              !Object.hasOwn(settings.config.profiles ?? {}, assignment.profile),
          );
          if (missing)
            return Err({
              reason: "source_profile_missing" as const,
              detail: `The profile ${missing.profile} for ${missing.key} does not exist. No source was written.`,
            });
          return Ok(plan);
        }),
      )
      .flatMap((plan) =>
        Projects.current(input).flatMap(({ data: project }) => {
          const id = crypto.randomUUID();
          const registeredAt = new Date().toISOString();
          const assignments = plan.assignments.map((assignment) => ({
            sourceId: id,
            key: assignment.key,
            completion: assignment.completion,
            state: "ready" as const,
          }));
          const state = decideSource({
            state: "open",
            assignments: plan.assignments.map((assignment) => ({
              key: assignment.key,
              completion: assignment.completion,
              state: "ready",
            })),
          });
          return DeviceState.registerSource(
            input.paths,
            project.checkout,
            {
              id,
              repository: project.repository,
              trackerKey: plan.trackerKey,
              state,
              registeredAt,
              endedAt: state === "finished" ? registeredAt : null,
              plan: JSON.stringify(plan),
            },
            assignments,
          ).map((source) => ({
            ...source,
            plan,
            assignments: assignments.map(({ key, completion, state }) => ({
              key,
              completion,
              state,
            })),
          }));
        }),
      );
  },
  show(input: Input & { sourceId: string }) {
    return read(input).map((sources) => {
      const source = sources[0];
      return (
        source && {
          ...source,
          reports: source.reports.map((report) => ({
            ...report,
            reference: reportReference(source.repository, source.id, report),
          })),
        }
      );
    });
  },
  /**
   * The accepted reports of an assignment's direct dependencies. A consumer brief copies this
   * content, so it does not depend on producer files that a reset or removal deletes.
   */
  dependencyReports(source: Source, assignment: string) {
    return dependencyReports(source, assignment);
  },
  /** The source state that follows from its assignment states, for writes that end work. */
  stateAfter(assignments: { key: string; completion: string; state: string }[]) {
    return decideSource({
      state: "open",
      assignments: z.array(assignmentStateSchema).parse(assignments),
    });
  },
  next(input: Input & { sourceId?: string }) {
    return read(input).flatMap((sources) =>
      fromThrowable(
        () => ({ sources: sources.map((source) => nextActions(input, source)) }),
        (cause, defect) =>
          cause instanceof z.ZodError
            ? {
                reason: "state_corrupt" as const,
                detail: "The source assignments do not match their plan.",
              }
            : defect(cause),
      )(),
    );
  },
  /** The report lifecycle rule. Device state applies it inside the transaction that read its facts. */
  decideReport(
    facts: Omit<Parameters<typeof decideReport>[0], "assignments"> & {
      assignments: { key: string; completion: string; state: string }[];
    },
  ) {
    return decideReport({
      ...facts,
      assignments: z.array(assignmentStateSchema).parse(facts.assignments),
    });
  },
};

type Source = ReturnType<typeof decodeSource>;

function dependencyReports(source: Source, assignment: string) {
  const planned = source.plan.assignments.find((row) => row.key === assignment);
  return (planned?.dependencies ?? []).flatMap((key) => {
    const report = source.reports.findLast(
      (row) => row.assignment === key && row.decision === "accepted",
    );
    return report === undefined
      ? []
      : [
          {
            assignment: key,
            report: report.number,
            conclusion: report.conclusion,
            unresolved: report.unresolved,
            reference: reportReference(source.repository, source.id, report),
          },
        ];
  });
}

function pullRequestFacts(pullRequest: PullRequest | undefined) {
  if (pullRequest === undefined) return {};
  return {
    pullRequest: pullRequest.waitStopped ? ("stopped" as const) : pullRequest.waitState,
    relay: pullRequest.relay?.state,
  };
}

function decide(input: Input, source: Source) {
  return source.plan.assignments.map((assignment) => {
    const current = source.assignments.find((row) => row.key === assignment.key);
    const dependencies = assignment.dependencies.map((key) =>
      source.assignments.find((row) => row.key === key),
    );
    if (current === undefined || dependencies.some((dependency) => dependency === undefined)) {
      // oxlint-disable-next-line unthrown/no-throw -- Inconsistent persisted rows are corruption, not permission to schedule work.
      throw new z.ZodError([]);
    }
    const launch = source.launches.findLast((row) => row.assignment === assignment.key);
    const pullRequest = source.pullRequests.find((pr) => pr.assignment === assignment.key);
    const report = source.reports.findLast((row) => row.assignment === assignment.key);
    const cleanup = source.cleanups.find((row) => row.assignment === assignment.key);
    const decision = decideAssignment({
      assignment: current,
      dependencies: dependencies.filter((dependency) => dependency !== undefined),
      // A start whose dispatching process stopped can be replaced.
      launch: launch?.abandoned === true ? "abandoned" : launch?.state,
      ...pullRequestFacts(pullRequest),
      activity: launch?.activity,
      report:
        report === undefined
          ? undefined
          : { decision: report.decision, cleanup: report.cleanupState },
      cleanup: cleanupFact(cleanup),
    });
    return described(
      input,
      source,
      { assignment: assignment.key, ...decision },
      { assignment: assignment.key, launch, pullRequest, report, cleanup },
    );
  });
}

/** Adds the recorded facts that the SuperAgent reads beside each decision. */
function described<T extends object>(
  input: Input,
  source: Source,
  decision: T,
  records: {
    assignment: string;
    launch: Launch | undefined;
    pullRequest: PullRequest | undefined;
    report: Report | undefined;
    cleanup: Cleanup | undefined;
  },
) {
  const row: T & {
    launch?: object;
    pullRequest?: object;
    report?: object;
    cleanup?: object;
    dependencyReports?: ReturnType<typeof dependencyReports>;
  } = { ...decision };
  const { launch, pullRequest, report, cleanup } = records;
  if (launch !== undefined) row.launch = launchSummary(launch);
  if (pullRequest !== undefined) row.pullRequest = pullRequestSummary(pullRequest);
  if (report !== undefined) row.report = reportSummary(input, source.repository, source.id, report);
  if (cleanup !== undefined) row.cleanup = cleanupSummary(cleanup);
  // Gaps of accepted dependency work stay visible until the dependent itself ends.
  const carried = dependencyReports(source, records.assignment);
  if (carried.length > 0) row.dependencyReports = carried;
  return row;
}

function nextActions(input: Input, source: Source) {
  const decisions = decide(input, source);
  // An ended source keeps the cleanup that its completed work still owes.
  const cleanup = decisions.filter(
    (decision) => decision.action === "retry_cleanup" || decision.action === "person_decision",
  );
  if (source.state !== "open")
    return {
      id: source.id,
      state: source.state,
      actions: [{ action: "source_ended", reason: source.state }, ...cleanup],
      waits: decisions.filter((decision) => decision.reason === "cleanup_running"),
    };
  return {
    id: source.id,
    state: source.state,
    actions: decisions.filter(
      (decision) => decision.action !== "wait" && decision.action !== "ended",
    ),
    waits: decisions.filter((decision) => decision.action === "wait"),
  };
}
