// Bun has no realpath API.
import { realpath } from "node:fs/promises";
import { Err, Ok, OkAsync, fromPromise, fromThrowable, type AsyncResult } from "unthrown";
import { z } from "zod";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";
import { WorktreePreparation } from "../worktree-preparation/main.ts";
import { pluginId, pluginManifestFile } from "./plugin.ts";
import { qualify, realOrNull, type Failure, type Paths } from "./observations.ts";

const eventSchema = z.object({
  event: z.string(),
  data: z.looseObject({
    pane_id: z.string().optional(),
    workspace_id: z.string().optional(),
    agent_status: z.string().optional(),
    status: z.string().optional(),
    worktree: z.object({ path: z.string() }).optional(),
  }),
});

function readEvent() {
  const environment = Environment.read();
  return fromThrowable(
    () =>
      eventSchema.parse(JSON.parse(environment.HERDR_PLUGIN_EVENT_JSON ?? "null")) satisfies object,
    (cause, defect) =>
      cause instanceof SyntaxError || cause instanceof z.ZodError
        ? { reason: "herdr_event_invalid", detail: "Herdr did not describe a supported event." }
        : defect(cause),
  )().flatMap((parsed) =>
    environment.HERDR_PLUGIN_EVENT === undefined
      ? Err<Failure>({ reason: "herdr_event_invalid", detail: "Herdr named no plugin event." })
      : Ok({
          name: environment.HERDR_PLUGIN_EVENT,
          data: parsed.data,
          socket: environment.HERDR_SOCKET_PATH ?? null,
        }),
  );
}

/** Herdr observations never complete work. They prepare worktrees and mark interrupted panes. */
export function observe(input: { paths: Paths }) {
  return readEvent()
    .toAsync()
    .flatMap(({ name, data, socket }): AsyncResult<{ reason: string; data: object }, Failure> => {
      if (name === "worktree.created" && data.worktree !== undefined)
        return WorktreePreparation.prepare({ paths: input.paths, worktree: data.worktree.path });
      if (data.pane_id === undefined)
        return OkAsync({ reason: "herdr_event_ignored", data: { event: name } });
      // An explicit close emits pane.closed, while a process that ends emits pane.exited.
      const exited = name === "pane.exited" || name === "pane.closed";
      return DeviceState.observePane(input.paths, {
        socket,
        paneId: data.pane_id,
        workspaceId: data.workspace_id ?? null,
        observation: exited
          ? { exited: true }
          : { exited: false, activity: data.agent_status ?? data.status ?? "unknown" },
      })
        .toAsync()
        .map((observed) => ({
          reason: exited ? "herdr_pane_exited" : "herdr_activity_observed",
          data: observed,
        }));
    });
}

/** The manifest lives in stable device state. An unrecorded plugin with the same id stays. */
export function installPlugin(input: { paths: Paths }) {
  const manifest = `${input.paths.herdrPlugin}/herdr-plugin.toml`;
  return Herdr.plugins().flatMap((plugins) =>
    fromPromise(async () => {
      const existing = plugins.find((plugin) => plugin.id === pluginId);
      const linked =
        existing === undefined ? null : ((await realOrNull(existing.root)) ?? existing.root);
      const wanted = (await realOrNull(input.paths.herdrPlugin)) ?? input.paths.herdrPlugin;
      // A conflict is refused before Operator writes its own manifest.
      if (linked !== null && linked !== wanted) return { conflict: true as const };
      const released = await Bun.file(pluginManifestFile).text();
      const current = Bun.file(manifest);
      const written = !(await current.exists()) || (await current.text()) !== released;
      if (written) await Bun.write(manifest, released, { createPath: true });
      const directory = await realpath(input.paths.herdrPlugin);
      return { conflict: false as const, written, directory, existing: linked };
    }, qualify).flatMap((found) => {
      if (found.conflict)
        return Err<Failure>({
          reason: "herdr_plugin_conflict",
          detail: `Herdr already links plugin ${pluginId} from another directory. It was not replaced.`,
        });
      const { written, directory, existing } = found;
      const data = { pluginId, manifest };
      if (existing !== null && !written) return OkAsync({ reason: "herdr_plugin_unchanged", data });
      // Herdr reads hooks when it links a manifest, so a changed manifest is linked again.
      if (existing !== null)
        return Herdr.unlinkPlugin(pluginId)
          .flatMap(() => Herdr.linkPlugin(directory))
          .map(() => ({ reason: "herdr_plugin_updated", data }));
      return Herdr.linkPlugin(directory).map(() => ({ reason: "herdr_plugin_linked", data }));
    }),
  );
}
