import { DoAsync, Err, Ok, OkAsync, fromPromise } from "unthrown";
import { DeviceSettings } from "../device-settings/main.ts";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { OperatorRelease } from "../operator-release/main.ts";
import { OwnedSkills } from "../owned-skills/main.ts";
import { Projects } from "../projects/main.ts";
import { Readiness } from "../readiness/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { WorktreePreparation } from "../worktree-preparation/main.ts";
import { renderBrief } from "./brief.ts";
import { chooseNames, launchBase } from "./names.ts";
import { pluginId, pluginManifestFile } from "./plugin.ts";
import { installPlugin, observe } from "./hooks.ts";
import {
  gitBranches,
  listFiles,
  parentBase,
  projectWorkspace,
  qualify,
  realOrNull,
  waitForPreparation,
  type Failure,
  type Paths,
} from "./observations.ts";

type Request = { paths: Paths; cwd: string; sourceId: string; assignment: string };
type OkOf<R> =
  R extends PromiseLike<infer A> ? OkOf<A> : R extends { tag: "Ok"; value: infer V } ? V : never;
type Facts = OkOf<ReturnType<typeof assignmentFacts>>;
type Settings = Facts & OkOf<ReturnType<typeof launchSettings>>;
type Resources = OkOf<ReturnType<typeof chooseResources>>;
type Placement = {
  workspaceId: string;
  tabId: string;
  paneId: string;
  workingDirectory: string;
  worktreePath: string | null;
  worktreeWorkspaceId: string | null;
  created: boolean;
};

function assignmentFacts(input: Request) {
  return (
    DoAsync()
      .bind("project", () => Projects.current(input).map(({ data }) => data))
      .bind("source", () => WorkSources.show(input))
      .bind("next", () => WorkSources.next(input))
      .bind("planned", ({ source, next }) => {
        const planned = source?.plan.assignments.find((row) => row.key === input.assignment);
        const action = next.sources[0]?.actions.find(
          (row) =>
            "assignment" in row &&
            row.assignment === input.assignment &&
            (row.action === "ready_assignment" || row.action === "replace_worker"),
        );
        return planned === undefined || action === undefined || source === undefined
          ? Err<Failure>({
              reason: "assignment_not_dispatchable",
              detail: `Assignment ${input.assignment} has no dispatch action. Read operator next for its waits. Nothing was launched.`,
            })
          : Ok({
              ...planned,
              sourceTrackerKey: source.trackerKey,
              dependencyReports: WorkSources.dependencyReports(source, planned.key),
            });
      })
      .let(
        "pullRequest",
        ({ source }) =>
          source?.pullRequests.find((row) => row.assignment === input.assignment) ?? null,
      )
      // A PR stacks on the branch of its one open parent PR. Next waits while several are open.
      .let("stack", ({ source, planned }) => {
        const open = (source?.assignments ?? []).filter(
          (row) => planned.dependencies.includes(row.key) && row.state === "pr-open",
        );
        const parent = source?.pullRequests.find((pr) => pr.assignment === open[0]?.key);
        return planned.completion === "pr" && open.length === 1 && parent !== undefined
          ? { assignment: parent.assignment, number: parent.number, branch: parent.branch }
          : null;
      })
      // An open PR lives on the worktree of an earlier start, even after a later start failed.
      .let("previous", ({ source, pullRequest }) =>
        source?.launches.findLast(
          (row) =>
            row.assignment === input.assignment &&
            (pullRequest === null ||
              (row.worktreePath !== null && row.branch === pullRequest.branch)),
        ),
      )
  );
}

/** Herdr reads hooks when it links a manifest, so a manifest from another release is stale. */
function pluginReady(paths: Paths) {
  return Herdr.plugins().flatMap((plugins) =>
    fromPromise(async () => {
      const installed = plugins.find((plugin) => plugin.id === pluginId);
      const expected = await realOrNull(paths.herdrPlugin);
      if (
        installed === undefined ||
        expected === null ||
        (await realOrNull(installed.root)) !== expected
      )
        return "herdr_plugin_missing";
      const linked = Bun.file(`${paths.herdrPlugin}/herdr-plugin.toml`);
      const released = await Bun.file(pluginManifestFile).text();
      return (await linked.exists()) && (await linked.text()) === released
        ? null
        : "herdr_plugin_outdated";
    }, qualify).flatMap((reason) =>
      reason === null
        ? Ok(undefined)
        : Err<Failure>({
            reason,
            detail:
              reason === "herdr_plugin_missing"
                ? "Run operator herdr install so new worktrees are prepared. Nothing was launched."
                : "The linked Herdr plugin is not the manifest of this release. Run operator herdr install. Nothing was launched.",
          }),
    ),
  );
}

/** Hooks report the socket of their server, so a launch must record the same socket. */
function herdrSession() {
  const socket = Environment.read().HERDR_SOCKET_PATH;
  return socket === undefined
    ? Err<Failure>({
        reason: "herdr_session_required",
        detail:
          "Run dispatch in a pane of the Herdr session that holds the project workspace. Nothing was launched.",
      })
    : Ok(socket);
}

function launchSettings(input: Request, facts: Facts) {
  return DoAsync()
    .bind("herdrSocket", () => herdrSession())
    .bind("ready", () =>
      Readiness.check(input.paths).flatMap(({ blockers }) =>
        blockers.length === 0
          ? Ok(undefined)
          : Err<Failure>({
              reason: "worker_not_ready",
              detail: `Static readiness failed: ${blockers.map((blocker) => blocker.reason).join(", ")}. Run operator ready. Nothing was launched.`,
            }),
      ),
    )
    .bind("plugin", () => pluginReady(input.paths))
    .bind("launch", () =>
      DeviceSettings.resolve({
        paths: input.paths,
        cwd: facts.project.checkout,
        role: "workerAgent",
        profile: facts.planned.profile,
      }),
    )
    .bind("release", () =>
      fromPromise(async () => {
        const manifest = await OperatorRelease.manifest();
        return {
          version: manifest.version,
          commit: manifest.commit,
          artifactIdentity: manifest.artifactIdentity,
        };
      }, qualify),
    )
    .bind("skills", () => fromPromise(() => OwnedSkills.identities(), qualify));
}

/** Every taken Herdr name, Git branch, or recorded launch name is skipped, never adopted. */
function chooseResources(input: Request, facts: Facts) {
  const checkout = facts.project.checkout;
  return DoAsync()
    .bind("workspace", () => projectWorkspace(checkout))
    .bind("agents", () => Herdr.agentNames())
    .bind("tabs", ({ workspace }) =>
      workspace.workspaceId === null ? Ok([]) : Herdr.tabLabels(workspace.workspaceId),
    )
    .bind("recorded", () => DeviceState.launchNames(input.paths))
    .bind("branches", () => gitBranches(checkout))
    .bind("reuse", () =>
      fromPromise(async () => {
        const path = facts.previous?.worktreePath ?? null;
        const branch = facts.previous?.branch ?? null;
        return path === null || branch === null || (await realOrNull(path)) === null
          ? null
          : { path, branch };
      }, qualify).flatMap((reuse) =>
        // A PR owner continues only on the PR's worktree. A new branch would lose the PR.
        facts.pullRequest !== null && reuse === null
          ? Err<Failure>({
              reason: "pr_worktree_missing",
              detail: `The recorded worktree of PR #${facts.pullRequest.number} on ${facts.pullRequest.branch} is missing. Ask the person how to recover it. Nothing was launched.`,
            })
          : Ok(reuse),
      ),
    )
    .bind("base", ({ reuse }) =>
      facts.stack === null || reuse !== null || facts.planned.resources !== "worktree"
        ? OkAsync(undefined)
        : parentBase(checkout, facts.stack.branch),
    )
    .bind("names", ({ workspace, agents, tabs, recorded, branches, reuse }) => {
      const names = chooseNames({
        base: launchBase(facts.planned),
        branch:
          facts.planned.resources === "worktree" && reuse === null ? facts.planned.branch : null,
        takenNames: new Set([...agents, ...tabs, ...workspace.labels, ...recorded]),
        takenBranches: branches,
      });
      return names === null
        ? Err<Failure>({
            reason: "launch_name_exhausted",
            detail: "No free launch name or branch remains. Nothing was launched.",
          })
        : Ok({ name: names.name, branch: reuse?.branch ?? names.branch });
    });
}

function ensureWorkspace(checkout: string, repository: string, workspaceId: string | null) {
  return workspaceId === null
    ? Herdr.createWorkspace({
        cwd: checkout,
        label: repository.split("/").at(-1) ?? repository,
      }).map((created) => created.workspaceId)
    : OkAsync(workspaceId);
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
      created: false,
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
    created: reuse === null,
  }));
}

/**
 * A reopened worktree emits no creation event. When its earlier preparation did not finish,
 * it is prepared here. Preparation keeps existing files, so a second run is safe.
 */
function preparedAgain(paths: Paths, worktree: string) {
  return fromPromise(async () => {
    const real = await realOrNull(worktree);
    if (real === null)
      return Err<Failure>({
        reason: "worktree_missing",
        detail: `The recorded worktree ${worktree} no longer exists.`,
      });
    const read = DeviceState.readPreparation(paths, real);
    if (read.tag !== "Ok") return read.flatMap(() => Ok(""));
    if (read.value?.state === "prepared") return Ok(read.value.detail);
    const prepared = await WorktreePreparation.prepare({ paths, worktree: real });
    if (prepared.tag === "Err")
      return Err<Failure>({ reason: "worktree_setup_failed", detail: prepared.error.detail });
    return prepared.map((done) => ("detail" in done.data ? String(done.data.detail) : done.reason));
  }, qualify).flatMap((result) => result);
}

function writeBrief(
  request: Request,
  settings: Settings,
  placement: Placement,
  branch: string | null,
) {
  const files = OperatorHome.assignmentFiles(request.paths, {
    repository: settings.project.repository,
    sourceId: request.sourceId,
    assignment: settings.planned.key,
  });
  return fromPromise(async () => {
    const text = renderBrief({
      sourceId: request.sourceId,
      sourceTrackerKey: settings.planned.sourceTrackerKey,
      assignment: settings.planned.key,
      trackerKey: settings.planned.trackerKey,
      completion: settings.planned.completion,
      profile: settings.launch.profile,
      instructions: settings.planned.instructions,
      workingDirectory: placement.workingDirectory,
      resources: branch === null ? { kind: "pane" } : { kind: "worktree", branch },
      reports: { directory: files.reports, files: await listFiles(files.reports) },
      followUps: { directory: files.followUps, files: await listFiles(files.followUps) },
      pullRequest: settings.pullRequest,
      dependencyReports: settings.planned.dependencyReports,
      stack: settings.stack,
    });
    await Bun.write(files.brief, text, { createPath: true });
    return files.brief;
  }, qualify);
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
  return DoAsync()
    .bind("workspaceId", () =>
      ensureWorkspace(checkout, repository, resources.workspace.workspaceId),
    )
    .bind("recordedWorkspace", ({ workspaceId }) => record({ workspaceId }))
    .bind("placement", ({ workspaceId }) =>
      place({ workspaceId, checkout, name, branch, reuse: resources.reuse, base: resources.base }),
    )
    .bind("recordedPlacement", ({ placement }) =>
      record({
        tabId: placement.tabId,
        paneId: placement.paneId,
        worktreePath: placement.worktreePath,
        worktreeWorkspaceId: placement.worktreeWorkspaceId,
      }),
    )
    .bind("preparation", ({ placement }) => {
      if (placement.worktreePath === null) return OkAsync(null);
      return placement.created
        ? waitForPreparation(request.paths, placement.worktreePath, input.startedAt)
        : preparedAgain(request.paths, placement.worktreePath);
    })
    .bind("brief", ({ placement }) => writeBrief(request, settings, placement, branch))
    .bind("agent", ({ placement }) =>
      Herdr.startAgent({
        name,
        kind: settings.launch.host === "claude-code" ? "claude" : "opencode",
        paneId: placement.paneId,
        args: settings.launch.command.args,
      }),
    )
    .bind("prompted", ({ brief }) => Herdr.prompt({ name, text: `Read ${brief} and follow it.` }))
    .bind("running", () => record({ state: "running" }))
    .map(({ workspaceId, placement, preparation, brief }) => ({
      brief,
      workspaceId,
      paneId: placement.paneId,
      worktreePath: placement.worktreePath,
      branch,
      preparation,
    }));
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
    },
  );
}

const interrupted: Failure = {
  reason: "launch_interrupted",
  detail:
    "Herdr reported that the pane ended before the launch finished, so the launch is recorded as interrupted. Read operator next before a replacement.",
};

/** A failed or stopped launch stays visible with every resource that it recorded. */
function recordFailure(paths: Paths, id: string, error: Failure) {
  // A pane exit observed during the start already ended the launch as interrupted.
  if (error.reason === "launch_not_starting") return Err(interrupted);
  return DeviceState.updateLaunch(paths, id, {
    state: "failed",
    failureReason: error.reason,
    failureDetail: error.detail,
  }).flatMap(() =>
    Err<Failure>({
      reason: "launch_failed",
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
      fromPromise(async () => {
        const release = guardStart(request.paths, reserved.id);
        const started = await launchEffects({
          request,
          settings,
          resources,
          id: reserved.id,
          startedAt,
        });
        release();
        if (started.tag === "Ok")
          return Ok({
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
            ...started.value,
          });
        return recordFailure(
          request.paths,
          reserved.id,
          started.tag === "Err"
            ? started.error
            : { reason: "launch_defect", detail: `Dispatch stopped: ${String(started.cause)}` },
        );
      }, qualify).flatMap((result) => result),
    );
}

function dispatch(request: Request) {
  return assignmentFacts(request).flatMap((facts) =>
    launchSettings(request, facts).flatMap((settings) =>
      chooseResources(request, facts).flatMap((resources) =>
        launch(request, { ...facts, ...settings }, resources),
      ),
    ),
  );
}

/** Launches WorkerAgents through Herdr and handles the stable plugin hooks. */
export const WorkerDispatch = {
  dispatch(input: Request) {
    return dispatch(input);
  },
  observe(input: { paths: Paths }) {
    return observe(input);
  },
  installPlugin(input: { paths: Paths }) {
    return installPlugin(input);
  },
};
