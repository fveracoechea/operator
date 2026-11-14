import { realPathOrNull } from "../../lib/real-path.ts";
import { DoAsync, Err, Ok, OkAsync, fromPromise, fromSafePromise } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { WorktreePreparation } from "../worktree-preparation/main.ts";
import { DeviceSettings } from "../device-settings/main.ts";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";
import { OperatorRelease } from "../operator-release/main.ts";
import { OwnedSkills } from "../owned-skills/main.ts";
import { Readiness } from "../readiness/main.ts";
import { pluginId, pluginManifestFile } from "./plugin.ts";
import { qualify, type Failure, type Paths } from "./observations.ts";

/** Herdr reads hooks when it links a manifest, so a manifest from another release is stale. */
function pluginReady(paths: Paths) {
  return Herdr.plugins().flatMap((plugins) =>
    fromPromise(
      async () => {
        const installed = plugins.find((plugin) => plugin.id === pluginId);
        const expected = await realPathOrNull(paths.herdrPlugin);
        if (installed === undefined)
          return { reason: "herdr_plugin_missing", state: { pluginLinked: false } };
        if (expected === null)
          return { reason: "herdr_plugin_missing", state: { devicePluginExists: false } };
        if ((await realPathOrNull(installed.root)) !== expected)
          return { reason: "herdr_plugin_missing", state: { pluginRootMatches: false } };
        const linked = Bun.file(`${paths.herdrPlugin}/herdr-plugin.toml`);
        const released = await Bun.file(pluginManifestFile).text();
        return (await linked.exists()) && (await linked.text()) === released
          ? null
          : { reason: "herdr_plugin_outdated", state: { manifestCurrent: false } };
      },
      (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
    ).flatMap((failure) =>
      failure === null
        ? Ok(undefined)
        : Err<Failure>({
            ...failure,
            next: {
              command: "operator herdr install",
              why: "Install the current release's Herdr plugin before dispatching.",
            },
            detail:
              failure.reason === "herdr_plugin_missing"
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
        next: { decider: "super-agent", question: "Which Herdr session should run this command?" },
        state: { herdrSessionPresent: false },
        detail:
          "Run this command in a pane of the Herdr session that holds the project workspace. Nothing was launched.",
      })
    : Ok(socket);
}

/** The checks and the launch snapshot that every WorkerAgent start needs, a reviewer included. */
export function launchSettings(paths: Paths, checkout: string, profile: string | undefined) {
  return DoAsync()
    .bind("herdrSocket", () => herdrSession())
    .bind("launch", () =>
      DeviceSettings.resolve({ paths, cwd: checkout, role: "workerAgent", profile }),
    )
    .flatTap(({ launch }) =>
      Readiness.check(paths, { host: launch.host }).flatMap(({ blockers }) =>
        blockers.length === 0
          ? Ok(undefined)
          : Err<Failure>({
              reason: "worker_not_ready",
              next: {
                command: "operator ready",
                why: "Read and correct the device readiness blockers.",
              },
              state: { ready: false },
              detail: `Static readiness failed: ${blockers.map((blocker) => blocker.reason).join(", ")}. Run operator ready. Nothing was launched.`,
            }),
      ),
    )
    .flatTap(() => pluginReady(paths))
    .bind("release", () =>
      fromPromise(
        async () => {
          const manifest = await OperatorRelease.manifest();
          return {
            version: manifest.version,
            commit: manifest.commit,
            artifactIdentity: manifest.artifactIdentity,
          };
        },
        (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
      ),
    )
    .bind("skills", () =>
      fromPromise(
        () => OwnedSkills.identities(),
        (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
      ),
    );
}

export function ensureWorkspace(checkout: string, repository: string, workspaceId: string | null) {
  if (workspaceId !== null) return OkAsync(workspaceId);
  const label = repository.split("/").at(-1) ?? repository;
  return Herdr.createWorkspace({ cwd: checkout, label }).flatMap((created) =>
    Herdr.renameTab({ tabId: created.tabId, label }).map(() => created.workspaceId),
  );
}

/**
 * A reopened worktree emits no creation event. When its earlier preparation did not finish,
 * it is prepared here. Preparation keeps existing files, so a second run is safe.
 */
export function preparedAgain(paths: Paths, worktree: string) {
  return fromSafePromise(async () => {
    const real = await realPathOrNull(worktree);
    if (real === null)
      return Err<Failure>({
        reason: "worktree_missing",
        next: {
          decider: "super-agent",
          question: "How should the recorded missing worktree be recovered?",
        },
        state: { worktreeExists: false },
        detail: `The recorded worktree ${worktree} no longer exists.`,
      });
    const read = DeviceState.readPreparation(paths, real);
    if (read.tag !== "Ok") return read.as(null);
    if (read.value?.state === "prepared") return Ok(read.value.detail);
    const prepared = await WorktreePreparation.prepare({ paths, worktree: real });
    if (prepared.tag === "Err")
      return Err<Failure>({
        reason: "worktree_setup_failed",
        detail: prepared.error.detail,
        next: {
          decider: "super-agent",
          question:
            "How should the recorded worktree preparation failure be corrected before retrying?",
        },
        state: { preparationSucceeded: false },
      });
    return prepared.map((done) => ("detail" in done.data ? String(done.data.detail) : done.reason));
  }).flatMap((result) => result);
}
