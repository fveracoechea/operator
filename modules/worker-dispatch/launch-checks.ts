import { DoAsync, Err, Ok, OkAsync, fromPromise } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { WorktreePreparation } from "../worktree-preparation/main.ts";
import { DeviceSettings } from "../device-settings/main.ts";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";
import { OperatorRelease } from "../operator-release/main.ts";
import { OwnedSkills } from "../owned-skills/main.ts";
import { Readiness } from "../readiness/main.ts";
import { pluginId, pluginManifestFile } from "./plugin.ts";
import { qualify, realOrNull, type Failure, type Paths } from "./observations.ts";

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
          "Run this command in a pane of the Herdr session that holds the project workspace. Nothing was launched.",
      })
    : Ok(socket);
}

/** The checks and the launch snapshot that every WorkerAgent start needs, a reviewer included. */
export function launchSettings(paths: Paths, checkout: string, profile: string | undefined) {
  return DoAsync()
    .bind("herdrSocket", () => herdrSession())
    .bind("ready", () =>
      Readiness.check(paths).flatMap(({ blockers }) =>
        blockers.length === 0
          ? Ok(undefined)
          : Err<Failure>({
              reason: "worker_not_ready",
              detail: `Static readiness failed: ${blockers.map((blocker) => blocker.reason).join(", ")}. Run operator ready. Nothing was launched.`,
            }),
      ),
    )
    .bind("plugin", () => pluginReady(paths))
    .bind("launch", () =>
      DeviceSettings.resolve({ paths, cwd: checkout, role: "workerAgent", profile }),
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

export function ensureWorkspace(checkout: string, repository: string, workspaceId: string | null) {
  return workspaceId === null
    ? Herdr.createWorkspace({
        cwd: checkout,
        label: repository.split("/").at(-1) ?? repository,
      }).map((created) => created.workspaceId)
    : OkAsync(workspaceId);
}

/**
 * A reopened worktree emits no creation event. When its earlier preparation did not finish,
 * it is prepared here. Preparation keeps existing files, so a second run is safe.
 */
export function preparedAgain(paths: Paths, worktree: string) {
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
