import { realPathOrNull } from "../../lib/real-path.ts";
import {
  DoAsync,
  Err,
  ErrAsync,
  Ok,
  OkAsync,
  fromPromise,
  fromSafePromise,
  type AsyncOkOf,
} from "unthrown";
import { DeviceSettings } from "../device-settings/main.ts";
import { DeviceState } from "../device-state/main.ts";
import { PrEntry } from "../pr-entry/main.ts";
import { AgentHosts } from "../agent-hosts/main.ts";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import type { NextStep, ResultContext } from "../../lib/cli-result.ts";
import { prepareBranch, readAdoption } from "./adoption.ts";
import { renderBrief } from "./brief.ts";
import { briefPhase } from "./brief-phase.ts";
import { internalReview } from "./internal-review.ts";
import { launchReviewer, moveReviewer, type ReviewerLaunch } from "./reviewer.ts";
import { cleanWorktree } from "./worktree-cleanup.ts";
import { handOver } from "./handover.ts";
import { ensureWorkspace, launchSettings, preparedAgain } from "./launch-checks.ts";
import { adoptedNames, chooseNames, launchBase } from "./names.ts";
import { installPlugin, observe } from "./hooks.ts";
import {
  gitBranches,
  listFiles,
  parentBase,
  projectWorkspace,
  qualify,
  waitForPreparation,
  type Failure,
  type Paths,
} from "./observations.ts";

type HandoffContinuation = Parameters<typeof DeviceState.checkHandoffContinuation>[1];
type Request = {
  paths: Paths;
  cwd: string;
  sourceId: string;
  assignment: string;
  continuation?: HandoffContinuation;
  kind?: string;
};
type WorkerKind = ReturnType<typeof WorkerKinds.resolve>;
/** A kind handoff starts its next worker while next shows the handoff as a wait. */
type DispatchRequest = Request & { handoff?: boolean };
type Facts = AsyncOkOf<ReturnType<typeof assignmentFacts>>;
type Settings = Facts & AsyncOkOf<ReturnType<typeof launchSettings>> & { kind: WorkerKind | null };
type Resources = AsyncOkOf<ReturnType<typeof chooseResources>>;
type Placement = {
  workspaceId: string;
  tabId: string;
  paneId: string;
  workingDirectory: string;
  worktreePath: string | null;
  worktreeWorkspaceId: string | null;
};

function notDispatchable(assignment: string, state: ResultContext["state"]) {
  return Err<Failure>({
    reason: "assignment_not_dispatchable",
    next: {
      command: "operator next",
      why: "Read the current assignment action before dispatching.",
    },
    state,
    detail: `Assignment ${assignment} has no dispatch action. Read operator next for its waits. Nothing was launched.`,
  });
}

/** Dispatch starts an assignment that next lists as ready or as needing a replacement. */
const dispatchActions = ["ready_assignment", "replace_worker", "resume_pr_feedback"];

function assignmentFacts(input: DispatchRequest, actions = dispatchActions) {
  return (
    DoAsync()
      .bind("project", () => Projects.current(input).map(({ data }) => data))
      .bind("source", () =>
        WorkSources.show(input).flatMap((source) =>
          source === undefined
            ? notDispatchable(input.assignment, { sourceExists: false })
            : Ok(source),
        ),
      )
      .bind("next", () => WorkSources.next(input))
      .bind("planned", ({ source, next }) => {
        const planned = source.planned.find((row) => row.key === input.assignment);
        if (planned === undefined)
          return notDispatchable(input.assignment, { assignmentPlanned: false });
        if (input.kind !== undefined && planned.kind !== null)
          return Err<Failure>({
            reason: "assignment_kind_set",
            detail: "The assignment already has a kind. Nothing changed.",
            next: { command: "operator next", why: "Use the recorded assignment kind." },
            state: { kind: planned.kind },
          });
        const kind = input.kind ?? planned.kind;
        if (kind === null)
          return Err<Failure>({
            reason: "assignment_kind_required",
            detail:
              "This assignment needs an explicit worker kind before its next launch. Nothing changed.",
            next: {
              command: `operator dispatch --source ${input.sourceId} --assignment ${input.assignment} --kind <kind>`,
              why: "Name a kind with the registered completion type.",
            },
            state: { kind: null },
          });
        const rows = next.sources
          .flatMap((row) => [...row.actions, ...row.waits])
          .filter((row) => "assignment" in row && row.assignment === input.assignment);
        if (rows.some((row) => row.reason === "kind_not_dispatchable"))
          return Err<Failure>({
            reason: "kind_not_dispatchable",
            detail: `The ${kind} kind starts through a handoff or adoption, not plain dispatch.`,
            next: {
              decider: "super-agent",
              question: "Which implementation assignment should hand this PR to its next worker?",
            } satisfies NextStep,
            state: { kind },
          });
        const held = rows.some((row) => row.reason === "running_cap_reached");
        if (held)
          return Err<Failure>({
            reason: "running_cap_reached",
            next: {
              command: "operator next --wait",
              why: "Wait for a running assignment to finish before dispatching more work.",
            },
            state: { maxRunning: source.plan.maxRunning, capReached: true },
            detail: `The plan's running cap of ${source.plan.maxRunning} is reached, so ${input.assignment} waits. Read operator next after a worker ends. Nothing was launched.`,
          });
        // A running handoff and a promoted worker's brief refresh are waits in next. Dispatch
        // matches no wait, because no wait has a dispatch action.
        const action = rows.find(
          (row) =>
            actions.includes(row.action) ||
            (input.handoff === true && row.reason === "kind_handoff"),
        );
        return action === undefined
          ? notDispatchable(input.assignment, {
              assignmentPlanned: true,
              dispatchActionExists: false,
            })
          : Ok({
              ...planned,
              kind,
              intent: planned.intent ?? source.plan.intent ?? null,
              sourceTrackerKey: source.trackerKey,
              maxRunning: source.plan.maxRunning,
              dependencyReports: WorkSources.dependencyReports(source, planned.key),
            });
      })
      .let(
        "pullRequest",
        ({ source }) =>
          source.pullRequests.find((row) => row.assignment === input.assignment) ?? null,
      )
      .let("review", ({ source, pullRequest }) => {
        const review = source.internalReviews.find((row) => row.assignment === input.assignment);
        const dispositions = new Map(
          (pullRequest?.readiness?.dispositions ?? []).map((item) => [
            `${item.round}.${item.finding}`,
            item,
          ]),
        );
        return review === undefined
          ? null
          : {
              state: review.state,
              rounds: source.internalReviewRounds
                .filter((round) => round.assignment === input.assignment)
                .map((round) => ({
                  ...round,
                  findings: round.findings.map((finding, index) => {
                    const disposition = dispositions.get(`${round.number}.${index + 1}`);
                    return disposition === undefined
                      ? finding
                      : {
                          ...finding,
                          disposition:
                            disposition.disposition === "declined"
                              ? `declined: ${disposition.reason}`
                              : "applied",
                        };
                  }),
                })),
              readyHead: review.readyHead,
              comment: review.commentUrl,
            };
      })
      .let("events", ({ pullRequest }) => pullRequest?.parking?.events ?? [])
      // An adopted PR is read at each start until its owner associates it. ADR-0024.
      .bind("adoption", ({ source, planned, pullRequest }) =>
        !("adopt" in planned) || planned.adopt === undefined || pullRequest !== null
          ? OkAsync(null)
          : readAdoption({
              repository: source.repository,
              number: planned.adopt,
              branch: planned.branch,
              kind: planned.kind,
              completion: planned.completion,
            }),
      )
      .flatTap(({ source, adoption }) =>
        adoption === null
          ? OkAsync(undefined)
          : DeviceState.checkAdoption(input.paths, {
              repository: source.repository,
              sourceId: input.sourceId,
              assignment: input.assignment,
              number: adoption.number,
              branch: adoption.branch,
            }),
      )
      .bind("adoptionHistory", ({ adoption, pullRequest, planned }) => {
        const number = adoption?.number ?? pullRequest?.number;
        return !("adopt" in planned) || planned.adopt === undefined || number === undefined
          ? OkAsync([])
          : WorkSources.adoptionHistory({
              paths: input.paths,
              cwd: input.cwd,
              number,
            });
      })
      // Only a start before the PR exists resolves internal review. After that, the recorded
      // review decides, so a settings change cannot drop a review that already started.
      // An adopted PR that is ready for review is already in front of people. ADR-0024.
      .bind("internalReview", ({ source, planned, pullRequest, review, adoption }) =>
        adoption?.draft === true && planned.kind === "review"
          ? OkAsync(true)
          : pullRequest !== null || adoption?.draft === false
            ? OkAsync(review !== null)
            : DeviceSettings.show(input.paths).map(({ data }) =>
                internalReview({
                  assignment: planned.completion === "pr" ? planned.internalReview : undefined,
                  plan: source.plan.internalReview,
                  device: data.config.review?.internal,
                }),
              ),
      )
      // An associated PR keeps its recorded parent base until its relay finishes.
      .let("stack", ({ source, planned, pullRequest }) => {
        if (pullRequest !== null) {
          const relay = pullRequest.relay;
          return relay === null || relay.state === "relayed" ? null : relay.parent;
        }
        // Next waits while several parents are open, before a PR is associated.
        const open = source.assignments.filter(
          (row) => planned.dependencies.includes(row.key) && row.state === "pr-open",
        );
        const parent = source.pullRequests.find((pr) => pr.assignment === open[0]?.key);
        // Stryker disable next-line ConditionalExpression, LogicalOperator: equivalent: next gives no dispatch action while several parents are open, and an open parent always has its PR
        const one = open.length === 1 && parent !== undefined;
        return planned.completion === "pr" && one
          ? { assignment: parent.assignment, number: parent.number, branch: parent.branch }
          : null;
      })
      .flatTap(({ adoption, stack, planned }) => {
        if (adoption === null) return OkAsync(undefined);
        if (adoption.number === null || (adoption.draft && planned.kind !== "review"))
          return OkAsync(undefined);
        const expected = stack?.branch ?? adoption.defaultBranch;
        return adoption.base === expected
          ? OkAsync(undefined)
          : ErrAsync<Failure>({
              reason: "adopt_pr_base_mismatch",
              detail: `The adopted PR's base is ${adoption.base}, not ${expected}. Correct its base before direct entry. Nothing was launched.`,
              next: {
                decider: "super-agent",
                question: "How should the adopted PR's base be corrected before dispatch?",
              },
              state: { base: adoption.base, expected },
            });
      })
      // An open PR lives on the worktree of an earlier start, even after a later start failed.
      // A promoted assignment's first start takes over the promoted report's worktree. ADR-0023.
      .let("previous", ({ source, pullRequest, planned }) => {
        const launch = source.launches.findLast(
          (row) =>
            row.assignment === input.assignment &&
            (pullRequest === null ||
              (row.worktreePath !== null && row.branch === pullRequest.branch)),
        );
        const promotion = planned.promotion;
        return launch === undefined && promotion !== null
          ? { worktreePath: promotion.worktreePath, branch: promotion.branch }
          : launch;
      })
  );
}

/**
 * Every taken Herdr name, Git branch, or recorded launch name is skipped, never adopted. The
 * branch of a PR that the plan adopts is the one exception. ADR-0024.
 */
function chooseResources(input: Request, facts: Facts) {
  const checkout = facts.project.checkout;
  return DoAsync()
    .bind("workspace", () => projectWorkspace(checkout))
    .bind("agents", () => Herdr.agentNames())
    .bind("tabs", ({ workspace }) =>
      // Stryker disable next-line ArrayDeclaration: equivalent: a taken name that no launch base can form changes no choice
      workspace.workspaceId === null ? Ok([]) : Herdr.tabLabels(workspace.workspaceId),
    )
    .bind("recorded", () => DeviceState.launchNames(input.paths))
    .bind("branches", () => gitBranches(checkout))
    .bind("reuse", () =>
      fromSafePromise(async () => {
        const path = facts.previous?.worktreePath ?? null;
        const branch = facts.previous?.branch ?? null;
        // Stryker disable next-line ConditionalExpression, LogicalOperator: equivalent: a launch with a worktree always records its branch, and the real-path check below refuses a missing path too
        if (path === null || branch === null) return null;
        return (await realPathOrNull(path)) === null ? null : { path, branch };
      }).flatMap((reuse) => {
        // A PR owner continues only on the PR's worktree. A new branch would lose the PR.
        if (facts.pullRequest !== null && reuse === null)
          return Err<Failure>({
            reason: "pr_worktree_missing",
            next: {
              decider: "person",
              question:
                "How should the missing PR worktree be recovered without losing unlanded work?",
            },
            state: { reusable: false },
            detail: `The recorded worktree of PR #${facts.pullRequest.number} on ${facts.pullRequest.branch} is missing. Ask the person how to recover it. Nothing was launched.`,
          });
        // A promoted assignment exists to keep the report's worktree. ADR-0023.
        if (facts.planned.promotion !== null && reuse === null)
          return Err<Failure>({
            reason: "promotion_worktree_missing",
            detail: `The worktree ${facts.planned.promotion.worktreePath} of promoted report ${facts.planned.promotion.report} is missing. Ask the person how to recover it. Nothing was launched.`,
            next: {
              decider: "person",
              question:
                "How should the missing promoted worktree be recovered without losing unlanded work?",
            },
            state: { reusable: false },
          });
        return Ok(reuse);
      }),
    )
    .bind("base", ({ reuse }) =>
      facts.stack === null || reuse !== null
        ? OkAsync(undefined)
        : parentBase(checkout, facts.stack.branch),
    )
    .bind("names", ({ workspace, agents, tabs, recorded, branches, reuse }) => {
      const takenNames = new Set([...agents, ...tabs, ...workspace.labels, ...recorded]);
      const adopted =
        facts.adoption?.branch ??
        ("adopt" in facts.planned && facts.planned.adopt !== undefined ? reuse?.branch : undefined);
      const names =
        adopted === undefined
          ? chooseNames({
              base: launchBase(facts.planned),
              branch:
                facts.planned.resources === "worktree" && reuse === null
                  ? facts.planned.branch
                  : null,
              takenNames,
              takenBranches: branches,
            })
          : adoptedNames(adopted, takenNames);
      return names === null
        ? Err<Failure>({
            reason: "launch_name_exhausted",
            next: {
              decider: "super-agent",
              question: "Which unused branch and worktree names should this assignment use?",
            },
            state: { namesAvailable: false },
            detail: "No free launch name or branch remains. Nothing was launched.",
          })
        : Ok({
            name: names.name,
            branch: reuse?.branch ?? names.branch,
          });
    })
    .flatTap(({ reuse }) =>
      // The last check, so a refusal before it leaves the local branch as it was.
      facts.adoption === null || reuse !== null
        ? OkAsync(undefined)
        : prepareBranch({
            checkout,
            repository: facts.project.repository,
            number: facts.adoption.number,
            branch: facts.adoption.branch,
            expectedHead: facts.adoption.head,
          }),
    );
}

function place(input: {
  workspaceId: string;
  checkout: string;
  name: string;
  branch: string | null;
  reuse: { path: string } | null;
  base: string | undefined;
}) {
  const { workspaceId, checkout, name, branch, reuse, base } = input;
  if (branch === null)
    return Herdr.createTab({ workspaceId, cwd: checkout, label: name }).map((tab): Placement => ({
      workspaceId,
      ...tab,
      workingDirectory: checkout,
      worktreePath: null,
      worktreeWorkspaceId: null,
    }));
  const worktree =
    reuse === null
      ? Herdr.createWorktree({ workspaceId, branch, label: name, base })
      : Herdr.openWorktree({ workspaceId, path: reuse.path, label: name }).map((opened) => ({
          ...opened,
          path: reuse.path,
        }));
  return worktree.map((opened): Placement => ({
    workspaceId,
    tabId: opened.tabId,
    paneId: opened.paneId,
    workingDirectory: opened.path,
    worktreePath: opened.path,
    worktreeWorkspaceId: opened.workspaceId,
  }));
}

async function reviewerNote(settings: Pick<Settings, "kind" | "pullRequest">) {
  if (settings.kind?.readsNote !== true) return null;
  const pr = settings.pullRequest;
  const file =
    pr?.parking === null || pr?.parking === undefined
      ? (pr?.readiness?.note ?? null)
      : pr.parking.note;
  return file === null ? null : Bun.file(file).text();
}

function writeBrief(
  request: Request,
  settings: Facts & { launch: { profile: string | null }; kind: WorkerKind | null },
  placement: { workingDirectory: string },
  branch: string | null,
  directEntry:
    | (Parameters<typeof DeviceState.adoptPullRequest>[2] & { mergedAt: null })
    | null = null,
) {
  const files = OperatorHome.assignmentFiles(request.paths, {
    repository: settings.project.repository,
    sourceId: request.sourceId,
    assignment: settings.planned.key,
  });
  const promotion = settings.planned.promotion;
  const phasePr = settings.pullRequest ?? directEntry;
  return fromPromise(
    async () => {
      const questions: NonNullable<Parameters<typeof renderBrief>[0]["questions"]> = [];
      for (const row of settings.source.questions)
        if (
          row.assignment === settings.planned.key &&
          // Stryker disable next-line ConditionalExpression: equivalent: decoded source questions with nonnull answer and authority must be answered; validQuestion rejects every contrary row before dispatch or refresh
          row.state === "answered" &&
          // Stryker disable next-line ConditionalExpression: equivalent: validQuestion requires every decoded answered question to have a nonnull answer before dispatch or refresh
          row.answer !== null &&
          // Stryker disable next-line ConditionalExpression: equivalent: validQuestion requires every decoded answered question to have a nonnull answer authority before dispatch or refresh
          row.answeredBy !== null
        )
          questions.push({
            key: row.key,
            question: row.question,
            answer: row.answer,
            by: row.answeredBy,
          });
      const commit =
        settings.pullRequest === null && settings.adoption === null
          ? null
          : await ToolInvocation.run({
              tool: "git",
              args: ["rev-parse", "--verify", "HEAD"],
              cwd: placement.workingDirectory,
              timeoutMs: 10000,
            });
      const text = renderBrief({
        sourceId: request.sourceId,
        sourceTrackerKey: settings.planned.sourceTrackerKey,
        assignment: settings.planned.key,
        trackerKey: settings.planned.trackerKey,
        completion: settings.planned.completion,
        kind: settings.kind,
        phase: briefPhase({
          kind: settings.kind,
          report:
            settings.source.reports.findLast((row) => row.assignment === settings.planned.key) ??
            null,
          pullRequest: phasePr,
          review:
            settings.review === null
              ? null
              : { state: settings.review.state, rounds: settings.review.rounds.length },
          internalReview: settings.internalReview,
        }),
        head: commit?.status === "completed" && commit.exitCode === 0 ? commit.stdout.trim() : null,
        questions,
        profile: settings.launch.profile,
        instructions: settings.planned.instructions,
        intent: settings.planned.intent,
        workingDirectory: placement.workingDirectory,
        branch,
        reports: { directory: files.reports, files: await listFiles(files.reports) },
        followUps: { directory: files.followUps, files: await listFiles(files.followUps) },
        pullRequest: settings.pullRequest,
        dependencyReports: settings.planned.dependencyReports,
        stack: settings.stack,
        internalReview: settings.internalReview,
        review: settings.review,
        note: await reviewerNote(settings),
        events: settings.events,
        promotion:
          promotion === null ? null : { report: promotion.report, number: promotion.reportNumber },
        adoption: settings.adoption,
        adoptionHistory: settings.adoptionHistory,
      });
      await Bun.write(files.brief, text);
      return files.brief;
    },
    // Stryker disable next-line ConditionalExpression: equivalent: qualify passes any cause without an I/O code to defect, as the other branch does
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  );
}

/** Herdr effects run with no database transaction open. Each returned resource is recorded. */
function launchEffects(input: {
  request: Request;
  settings: Settings;
  resources: Resources;
  id: string;
  startedAt: string;
}) {
  const { request, settings, resources } = input;
  const { checkout, repository } = settings.project;
  const { name, branch } = resources.names;
  function record(change: Parameters<typeof DeviceState.updateLaunch>[2]) {
    return DeviceState.updateLaunch(request.paths, input.id, change);
  }
  return (
    DoAsync()
      .bind("workspaceId", () =>
        ensureWorkspace(checkout, repository, resources.workspace.workspaceId),
      )
      .flatTap(({ workspaceId }) => record({ workspaceId }))
      .bind("placement", ({ workspaceId }) =>
        place({
          workspaceId,
          checkout,
          name,
          branch,
          reuse: resources.reuse,
          base: resources.base,
        }),
      )
      .flatTap(({ placement }) =>
        record({
          tabId: placement.tabId,
          paneId: placement.paneId,
          worktreePath: placement.worktreePath,
          worktreeWorkspaceId: placement.worktreeWorkspaceId,
        }),
      )
      // A new tab has its label already. The root tab of a worktree workspace has only a number.
      .flatTap(({ placement }) =>
        placement.worktreePath === null
          ? OkAsync(undefined)
          : Herdr.renameTab({ tabId: placement.tabId, label: name }),
      )
      .bind("preparation", ({ placement }) => {
        if (placement.worktreePath === null) return OkAsync(null);
        // A new worktree gets its preparation from the Herdr hook. A reopened one gets no event.
        return resources.reuse === null
          ? waitForPreparation(request.paths, placement.worktreePath, input.startedAt)
          : preparedAgain(request.paths, placement.worktreePath);
      })
      .bind("adopted", ({ placement }) => {
        const pr = settings.adoption;
        if (
          pr?.number === undefined ||
          pr.number === null ||
          (pr.draft && settings.kind?.name !== "review")
        )
          return OkAsync(null);
        return PrEntry.prepare({
          worktree: placement.workingDirectory,
          internalReview: settings.kind?.name === "review",
          draft: pr.draft,
          head: pr.head,
        }).flatMap(({ review, readiness }) => {
          const adopted: Parameters<typeof DeviceState.adoptPullRequest>[2] & { mergedAt: null } = {
            number: pr.number,
            url: pr.url,
            branch: pr.branch,
            mergedAt: null,
            relay:
              settings.stack === null
                ? null
                : JSON.stringify({ parent: settings.stack, state: "stacked", blocker: null }),
          };
          if (readiness !== null) adopted.readiness = readiness;
          return DeviceSettings.show(request.paths).flatMap(({ data }) =>
            DeviceState.adoptPullRequest(request.paths, input.id, adopted, {
              internalReview: review,
              assignmentReview: data.config.review?.assignments === true,
            }).map(() => adopted),
          );
        });
      })
      .bind("brief", ({ placement, adopted }) =>
        writeBrief(request, settings, placement, branch, adopted),
      )
      .flatTap(({ placement }) =>
        AgentHosts.start({
          name,
          launch: settings.launch,
          cwd: placement.workingDirectory,
          paneId: placement.paneId,
        }),
      )
      .flatTap(({ brief }) => Herdr.prompt({ name, text: `Read ${brief} and follow it.` }))
      .flatTap(() => record({ state: "running" }))
      .map(({ workspaceId, placement, preparation, brief }) => ({
        brief,
        workspaceId,
        paneId: placement.paneId,
        worktreePath: placement.worktreePath,
        branch,
        preparation,
      }))
  );
}

function reserve(request: Request, settings: Settings, resources: Resources, startedAt: string) {
  const { launch } = settings;
  return DeviceState.reserveLaunch(
    request.paths,
    settings.project.checkout,
    settings.project.repository,
    {
      id: crypto.randomUUID(),
      sourceId: request.sourceId,
      assignment: request.assignment,
      state: "starting",
      name: resources.names.name,
      resources: settings.planned.resources,
      branch: resources.names.branch,
      host: launch.host,
      model: launch.model,
      requestedModel: launch.requestedModel,
      reasoningEffort: launch.reasoningEffort,
      profile: launch.profile,
      release: JSON.stringify(settings.release),
      skills: JSON.stringify(settings.skills),
      kind: settings.kind === null ? null : JSON.stringify(settings.kind),
      herdrSocket: settings.herdrSocket,
      workspaceId: null,
      tabId: null,
      paneId: null,
      worktreePath: null,
      worktreeWorkspaceId: null,
      startedAt,
      endedAt: null,
      failureReason: null,
      failureDetail: null,
      activity: null,
      activityAt: null,
      // A report assignment has no internal review.
      internalReview: settings.planned.completion === "pr" ? settings.internalReview : null,
    },
    settings.planned.maxRunning,
    // The dispatching pane and session supervise the source.
    Environment.caller(),
    request.continuation,
    request.kind,
    settings.adoption === null
      ? undefined
      : {
          number: settings.adoption.number,
        },
  );
}

const interrupted: Failure = {
  reason: "launch_interrupted",
  next: {
    command: "operator next",
    why: "Read the recorded launch action before starting a replacement.",
  },
  detail:
    "Herdr reported that the pane ended before the launch finished, so the launch is recorded as interrupted. Read operator next before a replacement.",
};

/** A failed or stopped launch stays visible with every resource that it recorded. */
function recordFailure(paths: Paths, id: string, error: Failure) {
  // A pane exit observed during the start already ended the launch as interrupted.
  if (error.reason === "launch_not_starting") return Err({ ...interrupted, state: error.state });
  const state: NonNullable<ResultContext["state"]> = { launch: "failed" };
  if (error.state !== undefined) state.failure = error.state;
  return DeviceState.updateLaunch(paths, id, {
    state: "failed",
    failureReason: error.reason,
    failureDetail: error.detail,
  }).flatMap(() =>
    Err<Failure>({
      reason: "launch_failed",
      next: {
        command: "operator next",
        why: "Read the recorded launch action before starting a replacement.",
      },
      state,
      detail: `${error.reason}: ${error.detail} The launch is recorded as failed. Read operator next before a replacement.`,
    }),
  );
}

const signals = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;

/**
 * The lease shows other processes that this dispatch still runs. A signal records the stop
 * before exit. A process that cannot handle its stop leaves a lease that next reports abandoned.
 */
function guardStart(paths: Paths, id: string) {
  const release = DeviceState.holdLaunch(paths, id);
  const handlers = Object.entries(signals).map(([signal, code]) => {
    function handler() {
      DeviceState.updateLaunch(paths, id, {
        state: "failed",
        failureReason: "launch_stopped",
        failureDetail: `Dispatch received ${signal} before it recorded a launch outcome.`,
      });
      process.exit(128 + code);
    }
    process.once(signal, handler);
    return () => process.off(signal, handler);
  });
  return () => {
    release();
    for (const remove of handlers) remove();
  };
}

function launch(request: Request, settings: Settings, resources: Resources) {
  const startedAt = new Date().toISOString();
  return reserve(request, settings, resources, startedAt)
    .toAsync()
    .flatMap((reserved) =>
      fromSafePromise(async () => {
        const release = guardStart(request.paths, reserved.id);
        const started = await launchEffects({
          request,
          settings,
          resources,
          id: reserved.id,
          startedAt,
        }).map((effects) => ({
          sourceId: request.sourceId,
          assignment: request.assignment,
          attempt: reserved.attempt,
          name: resources.names.name,
          host: settings.launch.host,
          model: settings.launch.model,
          reasoningEffort: settings.launch.reasoningEffort,
          profile: settings.launch.profile,
          release: settings.release,
          skills: settings.skills,
          kind: settings.kind,
          ...effects,
        }));
        release();
        if (started.tag === "Ok") return started;
        if (started.tag === "Defect") {
          const recorded = DeviceState.updateLaunch(request.paths, reserved.id, {
            state: "failed",
            failureReason: "launch_defect",
            failureDetail: `Dispatch stopped: ${String(started.cause)}`,
          });
          // A bookkeeping failure must not replace the original defect or its nested cause.
          if (recorded.tag !== "Ok") return started;
          return started;
        }
        return recordFailure(request.paths, reserved.id, started.error);
      }).flatMap((result) => result),
    );
}

function dispatchSettings(request: Request, facts: Facts) {
  return launchSettings(request.paths, facts.project.checkout, facts.planned.profile).flatMap(
    (settings) => {
      const migrationParking = facts.pullRequest?.parking;
      const nextKind =
        migrationParking !== undefined && migrationParking !== null && "origin" in migrationParking
          ? undefined
          : facts.source.handoffs.find((row) => row.assignment === request.assignment)?.nextKind;
      const kindName = nextKind ?? facts.planned.kind;
      return (
        kindName === null
          ? OkAsync(null)
          : DeviceSettings.kind({
              paths: request.paths,
              name: kindName,
              host: settings.launch.host,
            })
      ).flatMap((definition) => {
        if (request.kind !== undefined && definition !== null && !definition.dispatchable)
          return Err<Failure>({
            reason: "kind_not_dispatchable",
            detail: `The ${definition.name} kind starts through a handoff or adoption, not plain dispatch.`,
            next: { command: "operator next", why: "Use the recorded handoff or adoption path." },
            state: { kind: definition.name },
          });
        if (definition !== null && definition.completion !== facts.planned.completion)
          return Err<Failure>({
            reason: "kind_completion_changed",
            detail: `Kind ${definition.name} no longer matches the registered completion type. Nothing was launched.`,
            next: {
              decider: "super-agent",
              question:
                "Should the kind's original completion type be restored, or should this work use a new plan?",
            },
            state: {
              kind: definition.name,
              registeredCompletion: facts.planned.completion,
              configuredCompletion: definition.completion,
            },
          });
        const kind =
          definition === null
            ? null
            : {
                ...definition,
                resources: facts.planned.resources,
                profile: settings.launch.profile,
                nextKind:
                  definition.name === "implementation" && !facts.internalReview
                    ? ("pr-feedback" as const)
                    : definition.nextKind,
                guide: definition.guide,
                skillsToRead: definition.skillsToRead.map(
                  (name) =>
                    `${request.paths.upstreamSkills[settings.launch.host]}/${name}/SKILL.md`,
                ),
              };
        return Ok({ ...facts, ...settings, kind });
      });
    },
  );
}

function dispatch(request: DispatchRequest) {
  return assignmentFacts(request).flatMap((facts) =>
    dispatchSettings(request, facts).flatMap((settings) =>
      chooseResources(request, facts).flatMap((resources) => launch(request, settings, resources)),
    ),
  );
}

/**
 * Rewrite the brief of the worker that took over a promoted report, from the running release's
 * PR template. Only the running launch that the promotion recorded has one. ADR-0023.
 */
function refreshBrief(request: Request) {
  return assignmentFacts(request, ["wait"]).flatMap((facts) => {
    const launch = facts.source.launches.findLast((row) => row.assignment === request.assignment);
    const worktreePath = launch?.worktreePath ?? null;
    if (
      launch === undefined ||
      launch.id !== facts.planned.promotion?.handoverLaunchId ||
      launch.state !== "running" ||
      worktreePath === null
    )
      return notDispatchable(request.assignment, { briefRefreshAllowed: false });
    return writeBrief(
      request,
      { ...facts, launch: { profile: launch.profile }, kind: launch.kind },
      { workingDirectory: worktreePath },
      launch.branch,
    );
  });
}

/** Launches WorkerAgents through Herdr and handles the stable plugin hooks. */
export const WorkerDispatch = {
  /** Reuses launch policy before a kind handoff claims state or closes its outgoing pane. */
  checkHandoff(input: Request) {
    return assignmentFacts({ ...input, handoff: true })
      .flatMap((facts) => dispatchSettings(input, facts))
      .map(() => undefined);
  },
  /** Resolves launch-time review policy for dispatch and a promoted worker's new PR launch. */
  resolveInternalReview(values: Parameters<typeof internalReview>[0]) {
    return internalReview(values);
  },
  dispatch(input: DispatchRequest) {
    return dispatch(input);
  },
  refreshBrief(input: Request) {
    return refreshBrief(input);
  },
  /**
   * Gives a promoted report's worktree branch, and a still running worker's Herdr name and tab,
   * the PR assignment's names. The answer can undo both while the promotion is not recorded.
   */
  handOver(input: Parameters<typeof handOver>[0]) {
    return handOver(input);
  },
  observe(input: { paths: Paths }) {
    return observe(input);
  },
  installPlugin(input: { paths: Paths }) {
    return installPlugin(input);
  },
  /** Starts a review request's reviewer. The review owner records the start and its outcome. */
  launchReviewer(input: ReviewerLaunch) {
    return launchReviewer(input);
  },
  /** Moves a reviewer worktree to a new PR head: a fast-forward, or a reset after a force push. */
  moveReviewer(input: Parameters<typeof moveReviewer>[0]) {
    return moveReviewer(input);
  },
  /**
   * Removes a worker worktree and its local branch only when Git establishes that they hold no
   * unlanded work. Otherwise it keeps both and names the work that only the person can delete.
   */
  cleanWorktree(input: Parameters<typeof cleanWorktree>[0]) {
    return cleanWorktree(input);
  },
};
