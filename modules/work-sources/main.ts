import {
  all,
  fromPromise,
  fromThrowable,
  Ok,
  Err,
  type AsyncResult,
  type ErrOf,
  type Result,
} from "unthrown";
import { z } from "zod";
import { DeviceState } from "../device-state/main.ts";
import { Projects } from "../projects/main.ts";
import { DeviceSettings } from "../device-settings/main.ts";
import { planSchema, promotionSchema } from "./plan.ts";
import { assignmentStateSchema, decideAssignment } from "./assignment-machine.ts";
import { decidePrune, decideReset, decideSource } from "./source-machine.ts";
import {
  decodeSource,
  findingSchema,
  type Cleanup,
  type InternalReview,
  type Launch,
  type PullRequest,
  type Message,
  type Question,
  type Report,
} from "./snapshot.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Environment } from "../environment/main.ts";
import { actionSet } from "./coordination.ts";
import { decideReport } from "./report-machine.ts";
import { qualify } from "./failures.ts";

type ResetRefusal =
  | Extract<ReturnType<typeof decideReset>, { tag: "Err" }>["error"]
  | { reason: "state_corrupt"; detail: string };
type Input = { paths: ReturnType<typeof OperatorHome.resolve>; cwd: string };

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

function reviewSummary(source: Source, review: InternalReview) {
  return {
    state: review.state,
    readyHead: review.readyHead,
    comment: review.commentUrl,
    rounds: source.internalReviewRounds
      .filter((round) => round.assignment === review.assignment)
      .map((round) => ({
        number: round.number,
        head: round.head,
        findings: round.findings.length,
        blockers: round.findings.filter((finding) => finding.severity === "blocker").length,
      })),
    handoff: {
      state:
        review.handoffState === "pending" && !review.handoffRunning
          ? "stopped"
          : review.handoffState,
      detail: review.handoffDetail,
    },
  };
}

function cleanupFact(cleanup: Cleanup | undefined) {
  if (cleanup === undefined) return undefined;
  if (cleanup.running) return "running";
  if (cleanup.state !== "blocked") return cleanup.state;
  return cleanup.reason === "cleanup_resource_mismatch" ? "resource_mismatch" : "unlanded_work";
}

function readProject(input: Input & { sourceId?: string }) {
  return Projects.current(input).flatMap(({ data: project }) =>
    readSources(input, project.repository).map((sources) => ({ project, sources })),
  );
}

function readSources(input: Input & { sourceId?: string }, repository: string) {
  return DeviceState.readSources(input.paths, repository, input.sourceId).flatMap((rows) =>
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

function read(input: Input & { sourceId?: string }) {
  return readProject(input).map(({ sources }) => sources);
}

// A start whose dispatching process stopped is abandoned, so it holds nothing.
function liveWorker(launch: { state: string; abandoned: boolean }) {
  return launch.state === "running" || (launch.state === "starting" && !launch.abandoned);
}

/** One retention rule for next actions and prune, over stored or decoded records. */
function retention(
  facts: {
    state: string;
    endedAt: string | null;
    launches: { state: string; abandoned: boolean }[];
    cleanups: { state: string }[];
    reports: { cleanupState: string | null }[];
  },
  now: number,
) {
  return decidePrune({
    state: facts.state,
    endedAt: facts.endedAt,
    now,
    cleanupOpen:
      facts.cleanups.some((cleanup) => cleanup.state !== "done") ||
      facts.reports.some(
        (report) => report.cleanupState !== null && report.cleanupState !== "done",
      ),
    workerRunning: facts.launches.some(liveWorker),
  });
}

/** Plans are supplied by the SuperAgent. No operation reads or updates a tracker. */
export const WorkSources = {
  register(input: Input & { file: string }) {
    return fromPromise(
      async () => planSchema.parse(await Bun.file(input.file).json()),
      (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
    )
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
          const state = decideSource({ state: "open", assignments });
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
  /**
   * Validates the findings of one internal review round: each has an axis, a severity, a
   * location, and a claim, and nothing else. ADR-0020.
   */
  parseFindings(text: string) {
    return fromThrowable(
      () => z.strictObject({ findings: z.array(findingSchema) }).parse(JSON.parse(text)).findings,
      (cause, defect) =>
        cause instanceof z.ZodError || cause instanceof SyntaxError
          ? {
              reason: "internal_review_findings_invalid" as const,
              detail: `The findings file must hold JSON {"findings": [...]}, where each finding has only axis (Spec, Standards, or Skills), severity (blocker or nice-to-have), location, and claim. ${cause instanceof z.ZodError ? z.prettifyError(cause).replaceAll("\n", " ") : cause.message} Nothing was recorded.`,
            }
          : defect(cause),
    )();
  },
  /** The source state that follows from its assignment states, for writes that end work. */
  stateAfter(assignments: { key: string; completion: string; state: string }[]) {
    return decideSource({
      state: "open",
      assignments: z.array(assignmentStateSchema).parse(assignments),
    });
  },
  /**
   * End one open source on the person's instruction. Merged and completed work stays, and the
   * other assignments are abandoned. No worktree, branch, pane, or tracker content changes.
   */
  reset(input: Input & { sourceId: string; personInstructed: boolean }) {
    if (!input.personInstructed)
      return Err({
        reason: "person_instruction_required" as const,
        detail:
          "Reset a source only on the person's explicit instruction. --person-instructed attests that instruction, it does not grant authority. Nothing changed.",
      });
    return Projects.current(input).flatMap(({ data: project }) => {
      // Stryker disable next-line ArrayDeclaration: equivalent: the reset rule sets both lists before any success reads them
      let preserved: string[] = [];
      // Stryker disable next-line ArrayDeclaration: equivalent: the reset rule sets both lists before any success reads them
      let abandoned: string[] = [];
      return DeviceState.resetSource(
        input.paths,
        { repository: project.repository, checkout: project.checkout, sourceId: input.sourceId },
        (facts): Result<{ abandon: string[] }, ResetRefusal> => {
          const parsed = z.array(assignmentStateSchema).safeParse(facts.assignments);
          // Any failure to read the stored plan is corruption.
          const plan = fromThrowable(
            () => planSchema.parse(JSON.parse(facts.source.plan)),
            // Stryker disable next-line ArrowFunction: equivalent: every failed plan read ends as the same state_corrupt refusal
            () => null,
          )();
          if (!parsed.success || plan.tag !== "Ok")
            return Err({
              reason: "state_corrupt" as const,
              detail:
                "The source assignments are invalid. They were not repaired. Nothing changed.",
            });
          return decideReset({
            state: facts.source.state,
            assignments: parsed.data,
            workers: facts.launches.filter(liveWorker),
          }).map((change) => {
            // Promoted assignments follow the registered ones. ADR-0023.
            const registered = plan.value.assignments.map((assignment) => assignment.key);
            const keys = [
              ...registered,
              ...parsed.data.map((row) => row.key).filter((key) => !registered.includes(key)),
            ];
            abandoned = keys.filter((key) => change.abandon.includes(key));
            // An assignment that was abandoned before the reset is neither kept nor changed.
            preserved = keys.filter(
              (key) =>
                !change.abandon.includes(key) &&
                parsed.data.find((row) => row.key === key)?.state !== "abandoned",
            );
            return change;
          });
        },
      ).map(({ source, retained }) => ({
        id: source.id,
        trackerKey: source.trackerKey,
        state: source.state,
        endedAt: source.endedAt,
        // Stryker disable next-line ArrayDeclaration: equivalent: the prunable time depends only on the state and the end time
        prunableAt: retention({ ...source, launches: [], cleanups: [], reports: [] }, 0).prunableAt,
        preserved,
        abandoned,
        retained,
      }));
    });
  },
  /**
   * Delete every ended source of the project whose 14-day retention has passed. A source with
   * open cleanup or a running worker stays. No retained worktree, branch, or backup is touched.
   */
  prune(input: Input) {
    return readProject(input).flatMap(({ project, sources }) => {
      const now = Date.now();
      const pruned: {
        id: string;
        trackerKey: string;
        state: string;
        endedAt: string | null;
        retained: { worktreePath: string | null; branch: string | null }[];
      }[] = [];
      const kept: {
        id: string;
        state: string;
        endedAt: string | null;
        prunableAt: string | null;
        reason: string;
      }[] = [];
      for (const source of sources) {
        if (source.state === "open") continue;
        const decision = retention(source, now);
        const row = { id: source.id, state: source.state, endedAt: source.endedAt };
        if (!decision.prune) {
          kept.push({ ...row, prunableAt: decision.prunableAt, reason: decision.reason });
          continue;
        }
        const result = DeviceState.pruneSource(
          input.paths,
          { repository: project.repository, checkout: project.checkout, sourceId: source.id },
          (facts) => retention({ ...facts.source, ...facts }, now).prune,
        );
        // A defect keeps its own channel. The map only restates the value type.
        // Stryker disable next-line ArrowFunction, ObjectLiteral: equivalent: the map callback never runs for a defect
        if (result.tag === "Defect") return result.map(() => ({ pruned, kept }));
        // A concurrent prune that removed the source first changed it under this read.
        if (result.tag === "Err" && result.error.reason === "source_not_found") {
          kept.push({ ...row, prunableAt: decision.prunableAt, reason: "source_changed" });
          continue;
        }
        if (result.tag === "Err")
          return Err({
            reason: result.error.reason,
            detail: `${pruned.length > 0 ? `Pruned ${pruned.map((item) => item.id).join(", ")}. ` : ""}Source ${source.id} and its records stay, so the next prune repeats it. ${result.error.detail}`,
          });
        if (result.value === null)
          kept.push({ ...row, prunableAt: decision.prunableAt, reason: "source_changed" });
        else
          pruned.push({ ...row, trackerKey: source.trackerKey, retained: result.value.retained });
      }
      return Ok({ pruned, kept });
    });
  },
  next(input: Input & { sourceId?: string }) {
    return read(input).map((sources) => nextAnswer(input, sources));
  },
  /**
   * Block until the set of non-wait actions differs from the set that the scope's last wait
   * returned, or until the timeout ends, and return the normal next answer. The returned set is
   * recorded, so a change between two waits returns at once, also after a restart.
   */
  wait(input: Input & { sourceId?: string; timeoutSeconds: number }) {
    return coordinationWait(input);
  },
  /** The PR assignment that a promotion adds, read from the SuperAgent's file. ADR-0023. */
  readPromotion(file: string) {
    return fromPromise(
      async () => promotionSchema.parse(await Bun.file(file).json()),
      (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
    );
  },
  /**
   * The sources that the agent session supervises whose next actions show running work while no
   * wait from that session covers them. Work that waits only for its dependencies runs nothing yet.
   */
  unwatched(input: Input & { session: string }) {
    return DeviceState.readSupervision(input.paths, input.session).flatMap((supervised) =>
      all(
        supervised
          .filter((source) => !source.waiting)
          .map((source) =>
            readSources({ ...input, sourceId: source.id }, source.repository).map((sources) =>
              nextAnswer(input, sources).sources.some((next) =>
                next.waits.some((row) => row.reason !== "dependencies_pending"),
              )
                ? [source.id]
                : [],
            ),
          ),
      ).map((ids) => ids.flat()),
    );
  },
  /**
   * Refuse a coordination command for a source that another agent session supervises. One session
   * coordinates a source at a time, so two SuperAgents never steer the same work. A source that no
   * session claimed yet passes, also when a pane holds it from before sessions were recorded.
   */
  checkSupervisor(input: Input & { sourceId: string }) {
    return Projects.current(input).flatMap(({ data: project }) =>
      DeviceState.readSupervisor(input.paths, project.repository, input.sourceId).flatMap(
        (
          supervisor,
        ): Result<undefined, { reason: "source_supervised_elsewhere"; detail: string }> => {
          const caller = Environment.caller();
          if (supervisor.session === null || supervisor.session === caller.session)
            return Ok(undefined);
          const where =
            supervisor.pane === null ? "outside Herdr" : `in Herdr pane ${supervisor.pane}`;
          return Err({
            reason: "source_supervised_elsewhere",
            detail: `Source ${input.sourceId} is supervised by agent session ${supervisor.session} ${where}, so this session does not coordinate it. Nothing changed. Leave it to that session. Only when the person tells you to supervise it here, run operator source take-over --source ${input.sourceId} --person-instructed --json.`,
          });
        },
      ),
    );
  },
  /**
   * Make the calling pane and session the supervisor of a source, on the person's instruction.
   * A caller without a session leaves the source to the next wait or dispatch.
   */
  takeOver(input: Input & { sourceId: string; personInstructed: boolean }) {
    if (!input.personInstructed)
      return Err({
        reason: "person_instruction_required" as const,
        detail:
          "Take over a source only on the person's explicit instruction. --person-instructed attests that instruction, it does not grant authority. Nothing changed.",
      });
    return Projects.current(input).flatMap(({ data: project }) => {
      const supervisor = Environment.caller();
      return DeviceState.takeOverSource(
        input.paths,
        project.repository,
        input.sourceId,
        supervisor,
      ).map((previous) => ({ sourceId: input.sourceId, previous, supervisor }));
    });
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
type CoordinationScope = Parameters<typeof DeviceState.startCoordinationWait>[1];
// The watch recurses, so it names the closed failures of the reads and the record it repeats.
type WatchFailure =
  | ErrOf<ReturnType<typeof readSources>>
  | ErrOf<ReturnType<typeof DeviceState.finishCoordinationWait>>;
type WatchOutcome = {
  reason: "next_actions_changed" | "next_wait_timed_out";
  data: ReturnType<typeof nextAnswer>;
};

function nextAnswer(input: Input, sources: Source[]) {
  const now = Date.now();
  // Decoding already refused rows that do not match their plan.
  return { sources: sources.map((source) => nextActions(input, source, now)) };
}

// A wait reads only local device state, so it can read often.
const coordinationPollMs = 2000;

function coordinationWait(input: Input & { sourceId?: string; timeoutSeconds: number }) {
  const deadline = Date.now() + input.timeoutSeconds * 1000;
  return Projects.current(input).flatMap(({ data: project }) => {
    const target = { repository: project.repository, scope: input.sourceId ?? "" };
    return DeviceState.startCoordinationWait(input.paths, target, Environment.caller())
      .toAsync()
      .flatMap((returned) => {
        // The lease shows that this wait still runs, so other operations can tell.
        const release = DeviceState.holdCoordinationWait(input.paths, target);
        return fromPromise(
          async () => {
            try {
              return await watchActions(input, target, returned, deadline);
            } finally {
              release();
            }
          },
          // Stryker disable next-line ArrowFunction: equivalent: the watch returns its failures as values, so only a defect reaches this mapping
          (cause, defect) => defect(cause),
        ).flatMap((result) => result);
      });
  });
}

/** Reads next actions until their set differs from the returned set or the deadline passes. */
function watchActions(
  input: Input & { sourceId?: string },
  target: CoordinationScope,
  returned: string | null,
  deadline: number,
): AsyncResult<WatchOutcome, WatchFailure> {
  // The project was resolved once, so each read touches only device state.
  const read = readSources(input, target.repository).map((sources) => nextAnswer(input, sources));
  return read.toAsync().flatMap((answer) => {
    const current = actionSet(answer);
    const changed = current !== returned;
    // Stryker disable next-line EqualityOperator: no rule: Operator promises no result for a read that ends in the same millisecond as the deadline
    if (changed || Date.now() >= deadline)
      return DeviceState.finishCoordinationWait(input.paths, target, current)
        .toAsync()
        .map(() => ({
          reason: changed ? "next_actions_changed" : "next_wait_timed_out",
          data: answer,
        }));
    return fromPromise(
      () => Bun.sleep(Math.min(coordinationPollMs, deadline - Date.now())),
      (cause, defect) => defect(cause),
    ).flatMap(() => watchActions(input, target, returned, deadline));
  });
}

function dependencyReports(source: Source, assignment: string) {
  const planned = source.planned.find((row) => row.key === assignment);
  if (planned === undefined) return [];
  return planned.dependencies.flatMap((key) => {
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

/** A handoff that a reviewer start ended is no longer a fact. */
function handoffFact(review: InternalReview | undefined) {
  if (review === undefined || review.handoffState === "done") return undefined;
  if (review.handoffState === "failed") return "failed";
  return review.handoffRunning ? "running" : "stopped";
}

function pullRequestFacts(pullRequest: PullRequest | undefined) {
  if (pullRequest === undefined) return {};
  return {
    pullRequest: pullRequest.waitStopped ? ("stopped" as const) : pullRequest.waitState,
    relay: pullRequest.relay?.state,
  };
}

// An unanswered question, a reply, or a message that needs attention explains an idle worker, so it
// replaces that attention. A pending message inside its period leaves the idle attention shown.
const idleReasons = new Set(["worker_idle", "pr_owner_idle"]);

/** The SuperAgent answers an open question. A question that it moved to the person waits on the person. */
function questionAction(question: Question) {
  const open = question.state === "open";
  return {
    assignment: question.assignment,
    action: open ? ("answer_question" as const) : ("person_decision" as const),
    reason: open ? ("question_open" as const) : ("question_awaiting_person" as const),
    blockers: [],
    question: { key: question.key, question: question.question, askedAt: question.askedAt },
  };
}

// A worker can be in a long turn when its doorbell rings, so the period exceeds a normal turn.
const acknowledgementPeriodMs = 15 * 60 * 1000;

/**
 * A reply waits on the SuperAgent. A pending message whose doorbell failed, or that the worker
 * left unacknowledged past the period since its last ring, needs worker attention.
 */
function messageAction(message: Message, now: number) {
  const shown = {
    key: message.key,
    message: message.message,
    sentAt: message.sentAt,
    questionKey: message.questionKey,
  };
  if (message.state === "replied")
    return {
      assignment: message.assignment,
      action: "read_reply" as const,
      reason: "message_replied" as const,
      blockers: [],
      message: { ...shown, reply: message.reply },
    };
  if (message.state !== "pending") return [];
  const failed = message.doorbellFailure !== null;
  const rung = Date.parse(message.rungAt ?? message.sentAt);
  if (!failed && now - rung < acknowledgementPeriodMs) return [];
  return {
    assignment: message.assignment,
    action: "worker_attention" as const,
    reason: failed ? ("doorbell_failed" as const) : ("message_unacknowledged" as const),
    blockers: [],
    message: { ...shown, rungAt: message.rungAt, doorbellFailure: message.doorbellFailure },
  };
}

/** The plan's assignments whose latest worker starts or runs. Each holds one place under the cap. */
function runningCount(source: Source) {
  // An ended assignment frees its place when the merge or acceptance is recorded, while its pane
  // and worktree may still close.
  const ended = new Set(
    source.assignments
      .filter((row) => ["merged", "completed", "abandoned"].includes(row.state))
      .map((row) => row.key),
  );
  const latest = new Map(
    source.launches.filter((row) => !ended.has(row.assignment)).map((row) => [row.assignment, row]),
  );
  return [...latest.values()].filter(liveWorker).length;
}

function decide(input: Input, source: Source, now: number) {
  const running = runningCount(source);
  return source.planned.flatMap((assignment) => {
    const questions = source.questions
      .filter(
        (row) =>
          row.assignment === assignment.key &&
          (row.state === "open" || row.state === "awaiting_person"),
      )
      .map(questionAction);
    const messages = source.messages
      .filter((row) => row.assignment === assignment.key)
      .flatMap((row) => messageAction(row, now));
    const recorded = [...questions, ...messages];
    const decision = decideAssignmentRow(input, source, assignment, running);
    return recorded.length > 0 && idleReasons.has(decision.reason)
      ? recorded
      : [...recorded, decision];
  });
}

function decideAssignmentRow(
  input: Input,
  source: Source,
  assignment: Source["planned"][number],
  running: number,
) {
  const { maxRunning } = source.plan;
  // Decoding matched each planned key to one stored row.
  const current = assignmentStateSchema.parse(
    source.assignments.find((row) => row.key === assignment.key),
  );
  const dependencies = z
    .array(assignmentStateSchema)
    .parse(assignment.dependencies.map((key) => source.assignments.find((row) => row.key === key)));
  const launch = source.launches.findLast((row) => row.assignment === assignment.key);
  const pullRequest = source.pullRequests.find((pr) => pr.assignment === assignment.key);
  const report = source.reports.findLast((row) => row.assignment === assignment.key);
  const cleanup = source.cleanups.find((row) => row.assignment === assignment.key);
  const review = source.internalReviews.find((row) => row.assignment === assignment.key);
  const decision = decideAssignment({
    assignment: current,
    dependencies,
    // A start whose dispatching process stopped can be replaced.
    launch: launch?.abandoned === true ? "abandoned" : launch?.state,
    ...pullRequestFacts(pullRequest),
    activity: launch?.activity,
    report:
      report === undefined
        ? undefined
        : { decision: report.decision, cleanup: report.cleanupState },
    cleanup: cleanupFact(cleanup),
    handoff: handoffFact(review),
    reviewing: review?.state === "reviewing",
    capReached: maxRunning !== undefined && running >= maxRunning,
  });
  const cap =
    decision.reason === "running_cap_reached" ? { runningCap: { maxRunning, running } } : {};
  return described(
    input,
    source,
    { assignment: assignment.key, ...decision, ...cap },
    { assignment: assignment.key, launch, pullRequest, report, cleanup, review },
  );
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
    review?: InternalReview | undefined;
  },
) {
  const row: T & {
    launch?: object;
    pullRequest?: object;
    report?: object;
    cleanup?: object;
    internalReview?: object;
    dependencyReports?: ReturnType<typeof dependencyReports>;
  } = { ...decision };
  const { launch, pullRequest, report, cleanup } = records;
  if (launch !== undefined) row.launch = launchSummary(launch);
  if (pullRequest !== undefined) row.pullRequest = pullRequestSummary(pullRequest);
  if (report !== undefined) row.report = reportSummary(input, source.repository, source.id, report);
  if (cleanup !== undefined) row.cleanup = cleanupSummary(cleanup);
  if (records.review !== undefined) row.internalReview = reviewSummary(source, records.review);
  // Gaps of accepted dependency work stay visible until the dependent itself ends.
  const carried = dependencyReports(source, records.assignment);
  if (carried.length > 0) row.dependencyReports = carried;
  return row;
}

function nextActions(input: Input, source: Source, now: number) {
  const decisions = decide(input, source, now);
  // An ended source keeps the cleanup that its completed work still owes.
  const cleanup = decisions.filter(
    (decision) => decision.action === "retry_cleanup" || decision.action === "person_decision",
  );
  if (source.state !== "open") {
    const kept = retention(source, now);
    return {
      id: source.id,
      state: source.state,
      actions: [
        {
          action: "source_ended",
          reason: source.state,
          endedAt: source.endedAt,
          prunableAt: kept.prunableAt,
        },
        ...(kept.prune ? [{ action: "prune_source", reason: "retention_elapsed" }] : []),
        ...cleanup,
      ],
      waits: decisions.filter((decision) => decision.reason === "cleanup_running"),
    };
  }
  return {
    id: source.id,
    state: source.state,
    actions: decisions.filter(
      (decision) => decision.action !== "wait" && decision.action !== "ended",
    ),
    waits: decisions.filter((decision) => decision.action === "wait"),
  };
}
