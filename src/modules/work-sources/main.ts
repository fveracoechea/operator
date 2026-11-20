import {
  all,
  fromPromise,
  fromSafePromise,
  fromThrowable,
  Ok,
  OkAsync,
  Err,
  type AsyncResult,
  type ErrOf,
  type Result,
} from "unthrown";
import { z } from "zod";
import { DeviceState } from "../device-state/main.ts";
import { Projects } from "../projects/main.ts";
import { DeviceSettings } from "../device-settings/main.ts";
import {
  configuredPlanSchema,
  storedPlanSchema,
  promotionSchema,
  questionPlan,
  oneOffPlan,
} from "./plan.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { assignmentStateSchema, decideAssignment } from "./assignment-machine.ts";
import { decidePrune, decideReset, decideSource } from "./source-machine.ts";
import {
  decodeSource,
  findingSchema,
  type Cleanup,
  type InternalReview,
  type KindHandoff,
  type Launch,
  type PullRequest,
  type Message,
  type Obligation,
  type Question,
  type Report,
} from "./snapshot.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Environment } from "../environment/main.ts";
import {
  actionKeys,
  eventKey,
  addKeys,
  changedAnswer,
  dropKeys,
  dueKeys,
  parseKey,
  parseSet,
  startWatch,
  type Watch,
} from "./coordination.ts";
import { decideReport } from "./report-machine.ts";
import { qualify } from "./failures.ts";
import { missingWorkers } from "./missing-workers.ts";
import type { ReviewRequests } from "../review-requests/main.ts";
// Bun has no synchronous directory metadata API.
import { lstatSync } from "node:fs";
import type { ResultContext, Refusal } from "../../lib/cli-result.ts";
import { readTextInput } from "../../lib/read-text-input.ts";

type ResetRefusal =
  | Extract<ReturnType<typeof decideReset>, { tag: "Err" }>["error"]
  | (ResultContext & { reason: "state_corrupt"; detail: string });
type Input = { paths: ReturnType<typeof OperatorHome.resolve>; cwd: string };
type ResourceIdentity = {
  id: string;
  assignment: string;
  state: string;
  name: string;
  paneId: string | null;
  herdrSocket: string | null;
  resources: string;
  worktreePath: string | null;
};

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
    pr_ready: pr.readiness !== null,
    readiness: pr.readiness,
    parking: pr.parking,
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
  return DeviceState.readSources(input.paths, repository, input.sourceId).flatMap(decodeRows);
}

function decodeRows(rows: import("unthrown").OkOf<ReturnType<typeof DeviceState.readSources>>) {
  return fromThrowable(
    () => rows.map(decodeSource),
    (cause, defect) =>
      cause instanceof z.ZodError || cause instanceof SyntaxError
        ? {
            reason: "state_corrupt" as const,
            detail: "Stored source records are invalid. They were not repaired.",
            next: {
              decider: "person" as const,
              question:
                "How should the damaged source records be recovered without overwriting them?",
            },
            state: { storedSourceValid: false },
          }
        : defect(cause),
  )();
}

function read(input: Input & { sourceId?: string }) {
  return readProject(input).map(({ sources }) => sources);
}

function resourcePaths(sources: Source[]) {
  return fromThrowable(
    () => {
      const missing = new Map<string, boolean>();
      for (const source of sources) {
        if (source.state !== "open") continue;
        for (const launch of source.launches) {
          if (launch.worktreePath !== null && !missing.has(launch.worktreePath))
            missing.set(
              launch.worktreePath,
              lstatSync(launch.worktreePath, { throwIfNoEntry: false }) === undefined,
            );
        }
      }
      return missing;
    },
    (cause, defect) => {
      const failure = cause instanceof Error ? qualify(cause, defect) : defect(cause);
      return "reason" in failure
        ? {
            ...failure,
            next: {
              decider: "person" as const,
              question:
                "How should access to the recorded resource paths be restored before retrying operator next?",
            },
            state: { operation: "resource_metadata" },
          }
        : failure;
    },
  )();
}

function resourceFacts(
  launch: { state: string; resources: string; worktreePath: string | null },
  missing: ReadonlyMap<string | null, boolean>,
  paneGone = false,
): NonNullable<Parameters<typeof decideAssignment>[0]["resources"]> {
  const worktreeGone = missing.get(launch.worktreePath) === true;
  return {
    kind: launch.resources === "pane" ? ("pane" as const) : ("worktree" as const),
    workerGone: paneGone || ["interrupted", "finished", "failed"].includes(launch.state),
    paneGone,
    worktreeGone,
  };
}

function observeSources(
  input: Input & { sourceId?: string },
  repository: string,
  selected?: Set<string> | null,
) {
  return DeviceState.readSources(input.paths, repository, input.sourceId)
    .flatMap((rows) =>
      decodeRows(rows).flatMap((decoded) =>
        resourcePaths(decoded.filter((source) => selected?.has(source.id) ?? true)).map(
          (missing) => ({ rows, decoded, missing }),
        ),
      ),
    )
    .toAsync()
    .flatMap(({ rows, decoded, missing }) => {
      const scoped = rows.filter((row) => selected?.has(row.source.id) ?? true);
      const candidates = scoped.flatMap((row) => {
        const active = new Set(
          row.assignments
            .filter(
              (assignment) => !["merged", "completed", "abandoned"].includes(assignment.state),
            )
            .map((assignment) => assignment.key),
        );
        const latest = new Map(
          row.launches
            .filter((launch) => active.has(launch.assignment))
            .map((launch) => [launch.assignment, launch]),
        );
        return [...latest.values()];
      });
      return missingWorkers(candidates, true).map((isMissing) => {
        const observed = candidates.map((launch) => ({
          launch,
          resources: resourceFacts(launch, missing, isMissing(launch)),
        }));
        const byId = new Map(observed.map((row) => [row.launch.id, row]));
        function unchanged(launch: ResourceIdentity) {
          const previous = byId.get(launch.id);
          return (
            previous !== undefined &&
            (
              [
                "assignment",
                "state",
                "name",
                "paneId",
                "herdrSocket",
                "resources",
                "worktreePath",
              ] as const
            ).every((key) => previous.launch[key] === launch[key])
          );
        }
        const changedIds = new Set(
          observed
            .filter(({ launch, resources }) => {
              return isMissing(launch) || (resources.workerGone && resources.worktreeGone);
            })
            .map(({ launch }) => launch.sourceId),
        );
        const changed = scoped.filter((row) => changedIds.has(row.source.id));
        return {
          missing,
          reconcile: () => {
            if (changed.length === 0) return Ok(decoded);
            return DeviceState.listProjects(input.paths)
              .flatMap(({ projects }) =>
                all(
                  changed.map(({ source }) =>
                    DeviceState.endAssignments(
                      input.paths,
                      {
                        repository,
                        checkout:
                          projects.find((project) => project.repository === repository)?.checkout ??
                          // Stryker disable next-line StringLiteral: equivalent: when concurrent removal deletes the project, any fallback checkout reaches the same controller_mismatch refusal
                          "",
                        sourceId: source.id,
                      },
                      (facts) => {
                        const interrupted = facts.launches
                          .filter((launch) => unchanged(launch) && isMissing(launch))
                          .map((launch) => launch.id);
                        const abandon = facts.assignments
                          .filter((assignment) => {
                            if (
                              [
                                "merged",
                                "completed",
                                // Stryker disable next-line StringLiteral: equivalent: the abandoned machine decision can only repeat its existing end; conversations are already closed
                                "abandoned",
                              ].includes(assignment.state)
                            )
                              return false;
                            const launch = facts.launches.findLast(
                              (row) => row.assignment === assignment.key,
                            );
                            if (launch === undefined || !unchanged(launch)) return false;
                            return (
                              decideAssignment({
                                assignment: assignmentStateSchema.parse(assignment),
                                // Stryker disable next-line ArrayDeclaration: equivalent: the machine decides ended before consulting dependencies; all later dependency decisions are not ended
                                dependencies: [],
                                // Stryker disable next-line OptionalChaining: equivalent: unchanged proved that this launch ID exists in byId immediately before this lookup
                                resources: byId.get(launch.id)?.resources,
                              }).action === "ended"
                            );
                          })
                          .map((assignment) => assignment.key);
                        return Ok({ abandon, interrupted });
                      },
                    ),
                  ),
                ),
              )
              .flatMap(() => readSources(input, repository));
          },
        };
      });
    });
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

/** Parses a supplied plan, checks its profiles against device settings, and writes the source. */
function registerPlan(input: Input, supply: () => Promise<object>, oneOff = false) {
  return DeviceSettings.show(input.paths)
    .flatMap(({ data: settings }) =>
      fromPromise(
        async () => configuredPlanSchema(settings.config.kinds, oneOff).parse(await supply()),
        (cause, defect) =>
          cause instanceof Error ? qualify(cause, defect, oneOff) : defect(cause),
      ).flatMap((plan) => {
        const missing = plan.assignments.find(
          (assignment) =>
            assignment.profile !== undefined &&
            !Object.hasOwn(settings.config.profiles ?? {}, assignment.profile),
        );
        if (missing)
          return Err({
            reason: "source_profile_missing" as const,
            next: {
              command: "operator config show",
              why: "Read the configured start profiles before correcting the plan.",
            },
            state: { profile: missing.profile, exists: false },
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
          kind: assignment.kind,
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
}

/** Plans are supplied by the SuperAgent. No operation reads or updates a tracker. */
export const WorkSources = {
  /** End one assignment without deleting a resource or closing its PR. */
  abandon(input: Input & { sourceId: string; assignment: string }) {
    return Projects.current(input).flatMap(({ data: project }) =>
      DeviceState.endAssignments(
        input.paths,
        {
          repository: project.repository,
          checkout: project.checkout,
          sourceId: input.sourceId,
        },
        (
          facts,
        ): Result<
          { abandon: string[]; interrupted?: string[] },
          ResultContext & {
            reason: "assignment_not_found" | "assignment_ended" | "state_corrupt";
            detail: string;
          }
        > => {
          const current = facts.assignments.find((row) => row.key === input.assignment);
          if (current === undefined)
            return Err({
              reason: "assignment_not_found" as const,
              detail: "The assignment does not exist in this source. Nothing changed.",
              next: {
                command: `operator source show --source ${input.sourceId}`,
                why: "Read the registered assignments.",
              },
              state: { assignment: input.assignment },
            });
          if (!assignmentStateSchema.safeParse(current).success)
            return Err({
              reason: "state_corrupt",
              detail: "The assignment state is invalid. It was not repaired. Nothing changed.",
              state: { found: current.state },
              next: {
                decider: "person",
                question: "How should the corrupt assignment record be recovered?",
              },
            });
          if (["merged", "completed", "abandoned"].includes(current.state))
            return Err({
              reason: "assignment_ended" as const,
              detail: "The assignment already ended. Nothing changed.",
              next: { why: "Nothing is left to abandon." },
              state: { found: current.state },
            });
          return Ok({ abandon: [input.assignment] });
        },
      ).map((result) => ({
        sourceId: input.sourceId,
        assignment: input.assignment,
        ...result,
        next: {
          command: `operator next --source ${input.sourceId}`,
          why: "Read the remaining work and retained resources.",
        },
      })),
    );
  },
  register(input: Input & { file: string }) {
    return registerPlan(input, () => Bun.file(input.file).json());
  },
  oneOff(
    input: Input & {
      kind: string;
      brief: string;
      intentFile?: string;
      profile?: string;
      trackerKey?: string;
      adopt?: string;
    },
  ) {
    return registerPlan(
      input,
      async () => {
        z.string()
          .refine((brief) => brief !== "-" || input.intentFile !== "-", {
            message: "The brief and intent cannot both read stdin. Supply a file for either field.",
          })
          .parse(input.brief);
        return oneOffPlan({
          ...input,
          instructions: await readTextInput(input.brief),
          intent:
            input.intentFile === undefined ? undefined : await readTextInput(input.intentFile),
        });
      },
      true,
    );
  },
  /**
   * Registers a SuperAgent's question as a one-off source with one answer-kind report
   * assignment, so the question needs no plan file. ADR-0027.
   */
  ask(input: Input & { file: string; profile?: string }) {
    return registerPlan(input, async () => {
      const question = z
        .string()
        .refine((text) => text.trim() !== "")
        .parse(await readTextInput(input.file));
      return questionPlan(question, input.profile);
    });
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
  /** Copy ended owners' facts, never their authority or readiness, into an adopted PR's brief. */
  adoptionHistory(input: Input & { number: number }) {
    return read(input).map((sources) =>
      sources.flatMap((source) =>
        source.pullRequests.flatMap((pr) => {
          if (pr.number !== input.number) return [];
          const ended =
            source.state !== "open" ||
            source.assignments.some(
              (row) => row.key === pr.assignment && ["abandoned", "merged"].includes(row.state),
            );
          if (!ended || pr.mergedAt !== null) return [];
          const planned = source.planned.find((row) => row.key === pr.assignment);
          const review = source.internalReviews.find((row) => row.assignment === pr.assignment);
          const dispositions = new Map(
            (pr.readiness?.dispositions ?? []).map((item) => [
              `${item.round}.${item.finding}`,
              item,
            ]),
          );
          return [
            {
              sourceId: source.id,
              assignment: pr.assignment,
              intent: planned?.intent ?? source.plan.intent ?? null,
              issue: planned?.trackerKey ?? source.trackerKey,
              summary: review?.commentUrl ?? null,
              rounds: source.internalReviewRounds
                .filter((row) => row.assignment === pr.assignment)
                .map((round) => ({
                  number: round.number,
                  head: round.head,
                  findings: round.findings.map((finding, index) => {
                    const disposition = dispositions.get(`${round.number}.${index + 1}`);
                    return {
                      ...finding,
                      disposition:
                        disposition === undefined
                          ? null
                          : disposition.disposition === "applied"
                            ? "applied"
                            : `declined: ${disposition.reason}`,
                    };
                  }),
                })),
            },
          ];
        }),
      ),
    );
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
    function invalid(line: number) {
      return Err({
        reason: "internal_review_findings_invalid" as const,
        detail: `Line ${line}: expected ## Findings, then bullets '- <severity>, <axis>, <location>: <claim>'. Nothing was recorded.`,
        next: {
          command: "operator pr round --file <path|->",
          why: "Correct the markdown findings and record the round again.",
        },
      });
    }
    const findings: z.infer<typeof findingSchema>[] = [];
    let heading = false;
    for (const [index, raw] of text.split(/\r?\n/).entries()) {
      const line = raw.trim();
      if (line === "") continue;
      if (!heading) {
        if (line !== "## Findings") return invalid(index + 1);
        heading = true;
        continue;
      }
      const match = /^- (blocker|nice-to-have), (Spec|Standards|Skills), (.+?):\s+(.+)$/.exec(line);
      if (match === null) return invalid(index + 1);
      const parsed = findingSchema.safeParse({
        severity: match[1],
        axis: match[2],
        location: match[3],
        claim: match[4],
      });
      if (!parsed.success) return invalid(index + 1);
      findings.push(parsed.data);
    }
    return heading ? Ok(findings) : invalid(1);
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
        next: {
          decider: "person" as const,
          question: "May this command run on your explicit instruction?",
        },
        state: { personInstructed: false },
        detail:
          "Reset a source only on the person's explicit instruction. --person-instructed attests that instruction, it does not grant authority. Nothing changed.",
      });
    return Projects.current(input).flatMap(({ data: project }) =>
      DeviceState.readSources(input.paths, project.repository, input.sourceId)
        .toAsync()
        .flatMap((sources) => missingWorkers(sources.flatMap((source) => source.launches)))
        .flatMap((isMissing) => {
          // Stryker disable next-line ArrayDeclaration: equivalent: the reset rule sets both lists before any success reads them
          let preserved: string[] = [];
          // Stryker disable next-line ArrayDeclaration: equivalent: the reset rule sets both lists before any success reads them
          let abandoned: string[] = [];
          return DeviceState.resetSource(
            input.paths,
            {
              repository: project.repository,
              checkout: project.checkout,
              sourceId: input.sourceId,
            },
            (facts): Result<{ abandon: string[]; interrupted: string[] }, ResetRefusal> => {
              const parsed = z.array(assignmentStateSchema).safeParse(facts.assignments);
              // Any failure to read the stored plan is corruption.
              const plan = fromThrowable(
                () => storedPlanSchema.parse(JSON.parse(facts.source.plan)),
                // Stryker disable next-line ArrowFunction: equivalent: every failed plan read ends as the same state_corrupt refusal
                () => null,
              )();
              if (!parsed.success || plan.tag !== "Ok")
                return Err({
                  reason: "state_corrupt" as const,
                  next: {
                    decider: "person",
                    question:
                      "How should the damaged source records be recovered without overwriting them?",
                  },
                  state: { storedSourceValid: false },
                  detail:
                    "The source assignments are invalid. They were not repaired. Nothing changed.",
                });
              return decideReset({
                state: facts.source.state,
                assignments: parsed.data,
                workers: facts.launches.filter(
                  (launch) => liveWorker(launch) && !isMissing(launch),
                ),
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
                return {
                  ...change,
                  // Stryker disable next-line MethodExpression: equivalent: reset has refused every unobserved running launch, and the transaction updates only running rows
                  interrupted: facts.launches.filter(isMissing).map((launch) => launch.id),
                };
              });
            },
          ).map(({ source, retained }) => ({
            id: source.id,
            trackerKey: source.trackerKey,
            state: source.state,
            endedAt: source.endedAt,
            // Stryker disable next-line ArrayDeclaration: equivalent: the prunable time depends only on the state and the end time
            prunableAt: retention({ ...source, launches: [], cleanups: [], reports: [] }, 0)
              .prunableAt,
            preserved,
            abandoned,
            retained,
          }));
        }),
    );
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
            ...result.error,
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
  /** The next answer. Without `all`, an ended source shows only what it still needs. */
  next(input: Input & { sourceId?: string; all?: boolean }) {
    return Projects.current(input)
      .flatMap(({ data: project }) => observeSources(input, project.repository))
      .flatMap(({ missing, reconcile }) =>
        reconcile().map((sources) => {
          const answer = nextAnswer(input, sources, missing);
          return input.all === true ? answer : withoutEnded(answer);
        }),
      );
  },
  /**
   * Block until an action appears that the scope's waits have not returned, or until the timeout
   * ends. The answer holds only the new actions, or with `all` the whole next answer of the
   * scope. The returned actions are recorded, so a change between two waits returns at once,
   * also after a restart. A wait without a source from an agent session covers every source that
   * the session supervises, in every project.
   */
  wait(input: WaitInput) {
    return coordinationWait(input);
  },
  /**
   * Run a SuperAgent command from an agent session, then record the actions that it added to the
   * named source, or to a source that it registered, as returned by the session's waits. A wait
   * never returns for a change that its own session made. A failed read or write only skips the record,
   * because the command's own result stands.
   */
  async acknowledgeOwnChange<T>(
    input: Input & { session: string; sourceId?: string; assignment?: string },
    change: () => Promise<T>,
  ) {
    const scope = { paths: input.paths, cwd: input.cwd };
    const before = await read(scope);
    const result = await change();
    const after = await read(scope);
    if (before.tag !== "Ok" || after.tag !== "Ok") return result;
    const known = new Set(before.value.map((source) => source.id));
    const priorAnswer = actionAnswer(input, before.value);
    const afterAnswer = actionAnswer(input, after.value);
    if (priorAnswer.tag !== "Ok" || afterAnswer.tag !== "Ok") return result;
    const prior = actionKeys(priorAnswer.value);
    const added = [...actionKeys(afterAnswer.value)].filter((key) => {
      if (prior.has(key)) return false;
      const [sourceId, assignment] = parseKey(key);
      if (input.sourceId === undefined) return !known.has(sourceId);
      return (
        sourceId === input.sourceId &&
        (input.assignment === undefined || assignment === input.assignment)
      );
    });
    if (added.length > 0)
      DeviceState.acknowledgeCoordinationWaits(input.paths, input.session, addKeys(added)).getOr(
        undefined,
      );
    return result;
  },
  /** The PR assignment that a promotion adds, read from the SuperAgent's file. ADR-0023. */
  readPromotion(file: string) {
    return fromPromise(
      async () => promotionSchema.parse(await Bun.file(file).json()),
      (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
    );
  },
  /**
   * The sources that the agent session supervises with a live worker launch while no wait from
   * that session covers them. Other waits and decisions do not keep the session's turn going.
   */
  unwatched(input: Input & { session: string }) {
    return DeviceState.readSupervision(input.paths, input.session).flatMap((supervised) =>
      all(
        supervised
          .filter((source) => !source.waiting)
          .map((source) =>
            readSources({ ...input, sourceId: source.id }, source.repository).map((sources) =>
              sources.some((source) => runningCount(source) > 0) ? [source.id] : [],
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
        ): Result<
          undefined,
          ResultContext & { reason: "source_supervised_elsewhere"; detail: string }
        > => {
          const caller = Environment.caller();
          if (supervisor.session === null || supervisor.session === caller.session)
            return Ok(undefined);
          const where =
            supervisor.pane === null ? "outside Herdr" : `in Herdr pane ${supervisor.pane}`;
          return Err({
            reason: "source_supervised_elsewhere",
            next: {
              decider: "super-agent",
              question:
                "Will the recorded supervisor continue, or should the person authorize a source take-over?",
            },
            state: { supervisorSession: supervisor.session, callerSession: caller.session },
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
        next: {
          decider: "person" as const,
          question: "May this command run on your explicit instruction?",
        },
        state: { personInstructed: false },
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
// The watch recurses, so it names the closed failures of the reads and the records it repeats.
type WatchFailure =
  | Refusal
  | ErrOf<ReturnType<typeof readSources>>
  | import("unthrown").AsyncErrOf<ReturnType<typeof observeSources>>
  | ErrOf<ReturnType<import("unthrown").AsyncOkOf<ReturnType<typeof observeSources>>["reconcile"]>>
  | ErrOf<ReturnType<typeof DeviceState.finishCoordinationWait>>;
type ReviewObservation = import("unthrown").AsyncOkOf<ReturnType<typeof ReviewRequests.upkeep>>;
type ReviewScope = Parameters<typeof ReviewRequests.upkeep>[0]["scopes"][number];
type CoordinationWatch = Watch & {
  reviewReadAt: number | null;
  reviewFailures: ReviewObservation["events"];
};
type Answer = {
  sources: (ReturnType<typeof nextActions> & { repository: string })[];
} & ReviewObservation;
type WatchOutcome = {
  reason: "next_actions_changed" | "next_wait_timed_out";
  data: Answer | ReturnType<typeof changedAnswer<Answer["sources"][number]["actions"][number]>>;
};

function actionAnswer(input: Input, sources: Source[]) {
  return resourcePaths(sources).map((missing) => nextAnswer(input, sources, missing));
}

function nextAnswer(input: Input, sources: Source[], missing: ReadonlyMap<string, boolean>) {
  const now = Date.now();
  // Decoding already refused rows that do not match their plan.
  return { sources: sources.map((source) => nextActions(input, source, now, missing)) };
}

/**
 * An ended source shows its prune and its owed cleanup, not its end, and leaves the answer
 * when nothing remains.
 */
function withoutEnded<T extends { sources: { actions: { action: string }[]; waits: unknown[] }[] }>(
  answer: T,
) {
  return {
    ...answer,
    sources: answer.sources.flatMap((source) => {
      const actions = source.actions.filter((row) => row.action !== "source_ended");
      return actions.length === 0 && source.waits.length === 0 ? [] : [{ ...source, actions }];
    }),
  };
}

// A wait reads only local device state, so it can read often.
const coordinationPollMs = 2000;

type WaitInput = Input & {
  sourceId?: string;
  timeoutSeconds: number;
  all?: boolean;
  observeParked?: () => AsyncResult<undefined, Refusal>;
  reviewUpkeep?: (input: {
    scopes: readonly ReviewScope[];
    observe: boolean;
  }) => ReturnType<typeof ReviewRequests.upkeep>;
};

function reviewScopes(input: WaitInput & { session: string | null }, repository: string) {
  if (input.sourceId !== undefined)
    return Ok<ReviewScope[]>([{ repository, sourceIds: [input.sourceId], manual: false }]);
  if (input.session === null) return Ok<ReviewScope[]>([{ repository }]);
  return DeviceState.readSupervision(input.paths, input.session).map((sources) =>
    [...new Set([repository, ...sources.map((source) => source.repository)])].map((repo) => ({
      repository: repo,
      sourceIds: sources.filter((source) => source.repository === repo).map((source) => source.id),
    })),
  );
}

function coordinationWait(input: WaitInput) {
  const deadline = Date.now() + input.timeoutSeconds * 1000;
  return Projects.current(input).flatMap(({ data: project }) => {
    const caller = Environment.caller();
    const { session } = caller;
    const scope =
      input.sourceId ?? (session === null ? "" : DeviceState.coordinationSessionScope(session));
    const target = { repository: project.repository, scope };
    return DeviceState.startCoordinationWait(input.paths, target, caller)
      .toAsync()
      .flatMap(() => {
        // The lease shows that this wait still runs, so other operations can tell.
        const release = DeviceState.holdCoordinationWait(input.paths, target);
        const watched = { ...input, session: input.sourceId === undefined ? session : null };
        return fromPromise(
          async () => {
            try {
              return await watchActions(
                watched,
                target,
                { ...startWatch(), reviewReadAt: null, reviewFailures: [] },
                deadline,
              );
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

/** The scope's next answer, each source with its project. A session wait reads its sources. */
function scopeAnswer(
  input: Input & { sourceId?: string; session: string | null },
  repository: string,
) {
  type Project = { repository: string; ids: Set<string> | null };
  const projects: Result<Project[], WatchFailure> =
    input.session === null
      ? Ok([{ repository, ids: null }])
      : DeviceState.readSupervision(input.paths, input.session).map((supervised) =>
          [...new Set(supervised.map((row) => row.repository))].map((supervisedIn) => ({
            repository: supervisedIn,
            ids: new Set(
              supervised.filter((row) => row.repository === supervisedIn).map((row) => row.id),
            ),
          })),
        );
  return projects.toAsync().flatMap((list) =>
    fromSafePromise(
      Promise.all(
        list.map((project) =>
          observeSources(input, project.repository, project.ids).map((observation) => ({
            project,
            observation,
          })),
        ),
      ),
    )
      .flatMap((results) => all(results))
      // Every scope observation must succeed before any project applies its ending effects.
      .flatMap((observations) =>
        all(
          observations.map(({ project, observation }) =>
            observation.reconcile().map((sources) =>
              nextAnswer(
                input,
                sources.filter((source) => project.ids?.has(source.id) ?? true),
                observation.missing,
              ).sources.map((source) => ({ ...source, repository: project.repository })),
            ),
          ),
        ),
      )
      .map((lists) => ({ sources: lists.flat() })),
  );
}

/**
 * Reads next actions until an action is due or the deadline passes. The stored set is read again
 * each time, so an acknowledgement that a session's command records during the wait counts, and a
 * removed action leaves the stored set, so its return is new again.
 */
function watchActions(
  input: WaitInput & { session: string | null },
  target: CoordinationScope,
  watch: CoordinationWatch,
  deadline: number,
): AsyncResult<WatchOutcome, WatchFailure> {
  // Read the source board before review upkeep commits transitions. An unrelated source-read
  // failure must not consume review events that this combined observation never returns.
  const read = (input.observeParked?.() ?? OkAsync(undefined))
    .flatMap(() => DeviceState.readCoordinationWait(input.paths, target))
    .flatMap((stored) =>
      scopeAnswer(input, target.repository).map((sources) => ({ stored, sources })),
    )
    .flatMap(({ stored, sources }) =>
      reviewScopes(input, target.repository).map((scopes) => ({ stored, sources, scopes })),
    )
    .flatMap(({ stored, sources, scopes }) => {
      const observe = watch.reviewReadAt === null || Date.now() - watch.reviewReadAt >= 30000;
      if (observe) watch.reviewReadAt = Date.now();
      const read =
        input.reviewUpkeep?.({ scopes, observe }) ??
        OkAsync<ReviewObservation>({ events: [], requests: [] });
      return read.map((reviews) => {
        if (observe) {
          watch.reviewFailures = reviews.events.filter((event) => event.kind === "read_failed");
          return { stored, answer: { ...sources, ...reviews } };
        }
        // An omitted GitHub read cannot clear a failed observation's acknowledgement.
        const visible = new Set(reviews.requests.map((request) => request.url));
        return {
          stored,
          answer: {
            ...sources,
            ...reviews,
            events: watch.reviewFailures.filter((event) => visible.has(event.url)),
          },
        };
      });
    })
    .flatMap(({ stored, answer }) => {
      const set = parseSet(stored);
      const current = actionKeys(answer);
      const dropped =
        set === null
          ? Ok(undefined)
          : DeviceState.changeCoordinationWait(
              input.paths,
              target,
              dropKeys([...set].filter((key) => !current.has(key))),
            ).discard();
      return dropped.map(() => ({ stored: set, answer, current }));
    });
  return read.flatMap(({ stored, answer, current }) => {
    const now = Date.now();
    // A scope that never returned a set returns at once with every action. It records the end of
    // each ended source without returning it, so a first session wait carries no old ends.
    const due =
      stored === null
        ? [...current]
        : [
            ...new Set([
              ...dueKeys({ stored, current, watch, now }),
              ...answer.events.map(eventKey).filter((key) => !stored.has(key)),
            ]),
          ];
    const shown = stored === null ? actionKeys(withoutEnded(answer)) : new Set(due);
    // Stryker disable next-line EqualityOperator: no rule: Operator promises no result for a read that ends in the same millisecond as the deadline
    if (shown.size > 0 || now >= deadline) {
      const changed = shown.size > 0;
      return DeviceState.finishCoordinationWait(input.paths, target, addKeys(due))
        .toAsync()
        .map(() => ({
          reason: changed ? ("next_actions_changed" as const) : ("next_wait_timed_out" as const),
          data: input.all === true ? answer : changedAnswer(answer, shown),
        }));
    }
    const initialized =
      stored === null
        ? DeviceState.changeCoordinationWait(input.paths, target, addKeys(current), {
            initialize: true,
          }).discard()
        : Ok(undefined);
    return initialized
      .toAsync()
      .flatMap(() =>
        fromPromise(
          () => Bun.sleep(Math.min(coordinationPollMs, deadline - Date.now())),
          (cause, defect) => defect(cause),
        ),
      )
      .flatMap(() => watchActions(input, target, watch, deadline));
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
            files: report.files,
            reference: reportReference(source.repository, source.id, report),
          },
        ];
  });
}

/** A handoff that a reviewer start ended is no longer a fact. */
function handoffFact(review: KindHandoff | undefined) {
  if (review === undefined || review.handoffState === "done") return undefined;
  if (review.handoffState === "failed") return "failed";
  return review.handoffRunning ? "running" : "stopped";
}

function pullRequestFacts(pullRequest: PullRequest | undefined) {
  if (pullRequest === undefined) return {};
  const facts: Pick<
    Parameters<typeof decideAssignment>[0],
    "pullRequest" | "relay" | "parked" | "prClosed" | "waking"
  > = {
    pullRequest: pullRequest.waitStopped ? ("stopped" as const) : pullRequest.waitState,
    relay: pullRequest.relay?.state,
    parked:
      pullRequest.parking?.state === "parked" ||
      (pullRequest.parking !== null &&
        "origin" in pullRequest.parking &&
        pullRequest.parking.state === "resuming"),
    prClosed: pullRequest.parking?.state === "closed",
  };
  if (pullRequest.parking !== null && pullRequest.parking.events.length > 0)
    facts.waking = wakingReason(pullRequest.parking.events);
  return facts;
}

// An unanswered question, a reply, or a message that needs attention explains an idle worker, so it
// replaces that attention. A pending message inside its period leaves the idle attention shown.
const idleReasons = new Set(["worker_idle"]);

function wakingReason(events: string[]) {
  const kinds = new Set(
    events.map((event) => z.object({ kind: z.string() }).parse(JSON.parse(event)).kind),
  );
  return kinds.has("feedback") || kinds.has("merge_eligible")
    ? ("pr_feedback" as const)
    : kinds.has("checks_failed")
      ? ("ci_failed" as const)
      : ("pr_relay_blocked" as const);
}

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

function decide(input: Input, source: Source, now: number, missing: ReadonlyMap<string, boolean>) {
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
    const decision = decideAssignmentRow(input, source, assignment, running, missing);
    return recorded.length > 0 && idleReasons.has(decision.reason)
      ? recorded
      : [...recorded, decision];
  });
}

function assignmentResources(
  source: Source,
  current: { key: string; state: string },
  launch: Launch | undefined,
  missing: ReadonlyMap<string, boolean>,
) {
  if (source.state !== "open") return { resources: undefined, retained: [] };
  const retained = new Map<string, { worktreePath: string; branch: string | null }>();
  for (const previous of source.launches) {
    if (
      previous.assignment === current.key &&
      previous.worktreePath !== null &&
      missing.get(previous.worktreePath) !== true
    )
      retained.set(previous.worktreePath, {
        worktreePath: previous.worktreePath,
        branch: previous.branch,
      });
  }
  const resources = launch === undefined ? undefined : resourceFacts(launch, missing);
  if (resources !== undefined) resources.retained = retained.size > 0;
  return { resources, retained: current.state === "abandoned" ? [...retained.values()] : [] };
}

function decideAssignmentRow(
  input: Input,
  source: Source,
  assignment: Source["planned"][number],
  running: number,
  missing: ReadonlyMap<string, boolean>,
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
  const { resources, retained } = assignmentResources(source, current, launch, missing);
  const decision = decideAssignment({
    assignment: current,
    dependencies,
    dispatchable:
      WorkerKinds.dispatchable(assignment.kind) ||
      ("adopt" in assignment && assignment.adopt !== undefined),
    // A start whose dispatching process stopped can be replaced.
    launch: launch?.abandoned === true ? "abandoned" : launch?.state,
    ...pullRequestFacts(pullRequest),
    activity: launch?.activity,
    report:
      report === undefined
        ? undefined
        : { decision: report.decision, cleanup: report.cleanupState },
    cleanup: cleanupFact(cleanup),
    handoff: handoffFact(source.handoffs.find((row) => row.assignment === assignment.key)),
    reviewing: review?.state === "reviewing",
    capReached: maxRunning !== undefined && running >= maxRunning,
    resources,
  });
  const cap =
    decision.reason === "running_cap_reached" ? { runningCap: { maxRunning, running } } : {};
  const kind: { kind?: string | null } = { kind: assignment.kind };
  const row = described(
    input,
    source,
    {
      assignment: assignment.key,
      ...kind,
      ...decision,
      ...cap,
    },
    { assignment: assignment.key, launch, pullRequest, report, cleanup, review },
  );
  return retained.length > 0 ? { ...row, retainedResources: retained } : row;
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
    handoff?: object;
    dependencyReports?: ReturnType<typeof dependencyReports>;
  } = { ...decision };
  const { launch, pullRequest, report, cleanup } = records;
  if (launch !== undefined) row.launch = launchSummary(launch);
  if (pullRequest !== undefined) row.pullRequest = pullRequestSummary(pullRequest);
  if (report !== undefined) row.report = reportSummary(input, source.repository, source.id, report);
  if (cleanup !== undefined) row.cleanup = cleanupSummary(cleanup);
  if (records.review !== undefined) row.internalReview = reviewSummary(source, records.review);
  const handoff = source.handoffs.find((entry) => entry.assignment === records.assignment);
  if (handoff !== undefined)
    row.handoff = {
      outgoingLaunchId: handoff.outgoingLaunchId,
      nextKind: handoff.nextKind,
      state:
        handoff.handoffState === "pending" && !handoff.handoffRunning
          ? "stopped"
          : handoff.handoffState,
      detail: handoff.handoffDetail,
    };
  // Gaps of accepted dependency work stay visible until the dependent itself ends.
  const carried = dependencyReports(source, records.assignment);
  if (carried.length > 0) row.dependencyReports = carried;
  return row;
}

/**
 * What the SuperAgent still owes the person. It is shown beside the actions, not as one, so the
 * SuperAgent's own addition or close wakes no coordination wait. ADR-0026.
 */
function owed(obligations: Obligation[]) {
  return obligations
    .filter((row) => row.state === "open")
    .map(({ key, kind, summary, reference, openedAt }) => ({
      key,
      kind,
      summary,
      reference,
      openedAt,
    }));
}

function nextActions(
  input: Input,
  source: Source,
  now: number,
  missing: ReadonlyMap<string, boolean>,
) {
  const decisions = decide(input, source, now, missing);
  // An ended source keeps the cleanup that its completed work still owes.
  const cleanup = decisions.filter(
    (decision) => decision.action === "clean_up" || decision.action === "person_decision",
  );
  if (source.state !== "open") {
    const kept = retention(source, now);
    return {
      id: source.id,
      state: source.state,
      actions: [
        {
          action: "source_ended" as const,
          reason: source.state,
          endedAt: source.endedAt,
          prunableAt: kept.prunableAt,
        },
        ...(kept.prune ? [{ action: "prune_source" as const, reason: "retention_elapsed" }] : []),
        ...cleanup,
      ],
      waits: decisions.filter((decision) => decision.reason === "cleanup_running"),
      owed: owed(source.obligations),
    };
  }
  return {
    id: source.id,
    state: source.state,
    actions: decisions.filter(
      (decision) =>
        decision.action !== "wait" &&
        (decision.action !== "ended" ||
          source.assignments.some(
            (row) => row.key === decision.assignment && row.state === "abandoned",
          )),
    ),
    waits: decisions.filter((decision) => decision.action === "wait"),
    owed: owed(source.obligations),
  };
}
