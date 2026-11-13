import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory, realpath, symlink, permission, time, or recursive removal API.
import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Err, ErrAsync, Ok, OkAsync } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { WorktreePreparation } from "../worktree-preparation/main.ts";
import { installPlugin, observe } from "./hooks.ts";
import { pluginManifestFile } from "./plugin.ts";

// Root ignores file modes, so a test of a denied access cannot run as root.
const asRoot = process.getuid?.() === 0;

const environment = Environment.read();
const released = await Bun.file(pluginManifestFile).text();
let root = "";
let paths: ReturnType<typeof OperatorHome.resolve>;
let manifest = "";

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-hooks-")));
  paths = OperatorHome.resolve(Environment.parse({ HOME: `${root}/home`, NODE_ENV: "test" }));
  manifest = `${paths.herdrPlugin}/herdr-plugin.toml`;
});

afterEach(async () => {
  mock.restore();
  await chmod(root, 0o700);
  await rm(root, { recursive: true, force: true });
});

function event(name: string | undefined, json: string | undefined, socket?: string) {
  spyOn(Environment, "read").mockReturnValue({
    ...environment,
    HERDR_PLUGIN_EVENT: name,
    HERDR_PLUGIN_EVENT_JSON: json,
    HERDR_SOCKET_PATH: socket,
  });
}

const observed = { launches: ["launch"], reviewers: [] };

function observePane() {
  return spyOn(DeviceState, "observePane").mockReturnValue(Ok(observed));
}

test("a new worktree is prepared", async () => {
  const prepared = { reason: "worktree_prepared", data: { worktree: "/w" } };
  const prepare = spyOn(WorktreePreparation, "prepare").mockReturnValue(OkAsync(prepared));
  event(
    "worktree.created",
    JSON.stringify({ event: "worktree_created", data: { worktree: { path: "/w" } } }),
  );
  expect(await observe({ paths })).toEqual(Ok(prepared));
  expect(prepare).toHaveBeenCalledWith({ paths, worktree: "/w" });
});

test.each([
  { name: "worktree.created", data: {} },
  { name: "pane.agent_status_changed", data: { worktree: { path: "/w" } } },
])("a $name event without a pane is ignored", async ({ name, data }) => {
  const prepare = spyOn(WorktreePreparation, "prepare");
  const pane = observePane();
  event(name, JSON.stringify({ event: "x", data }));
  expect(await observe({ paths })).toEqual(
    Ok({ reason: "herdr_event_ignored", data: { event: name } }),
  );
  expect(prepare).not.toHaveBeenCalled();
  expect(pane).not.toHaveBeenCalled();
});

test.each(["pane.exited", "pane.closed"])(
  "a %s event marks the pane exit on the hook's server",
  async (name) => {
    const prepare = spyOn(WorktreePreparation, "prepare");
    const pane = observePane();
    event(
      name,
      JSON.stringify({
        event: "x",
        data: { pane_id: "p1", workspace_id: "w1", worktree: { path: "/w" } },
      }),
      "/sock",
    );
    expect(await observe({ paths })).toEqual(Ok({ reason: "herdr_pane_exited", data: observed }));
    expect(pane).toHaveBeenCalledWith(paths, {
      socket: "/sock",
      paneId: "p1",
      workspaceId: "w1",
      observation: { exited: true },
    });
    expect(prepare).not.toHaveBeenCalled();
  },
);

test.each([
  { data: { agent_status: "working", status: "idle" }, activity: "working" },
  { data: { status: "idle" }, activity: "idle" },
  { data: {}, activity: "unknown" },
])("agent activity $activity is recorded without a server or workspace", async (row) => {
  const pane = observePane();
  event(
    "pane.agent_status_changed",
    JSON.stringify({ event: "x", data: { pane_id: "p1", ...row.data } }),
  );
  expect(await observe({ paths })).toEqual(
    Ok({ reason: "herdr_activity_observed", data: observed }),
  );
  expect(pane).toHaveBeenCalledWith(paths, {
    socket: null,
    paneId: "p1",
    workspaceId: null,
    observation: { exited: false, activity: row.activity },
  });
});

test.each([
  { name: "pane.exited", json: undefined },
  { name: "pane.exited", json: "not json" },
  { name: "pane.exited", json: JSON.stringify({ event: "x" }) },
  { name: "pane.exited", json: JSON.stringify({ event: "x", data: { pane_id: 1 } }) },
  {
    name: "worktree.created",
    json: JSON.stringify({ event: "x", data: { worktree: { path: 1 } } }),
  },
])("an unsupported description refuses the event", async ({ name, json }) => {
  const pane = observePane();
  event(name, json);
  expect(await observe({ paths })).toEqual(
    Err({ reason: "herdr_event_invalid", detail: "Herdr did not describe a supported event." }),
  );
  expect(pane).not.toHaveBeenCalled();
});

test("an event without a name is refused", async () => {
  const pane = observePane();
  event(undefined, JSON.stringify({ event: "x", data: { pane_id: "p1" } }));
  expect(await observe({ paths })).toEqual(
    Err({ reason: "herdr_event_invalid", detail: "Herdr named no plugin event." }),
  );
  expect(pane).not.toHaveBeenCalled();
});

function herdr(plugins: { id: string; root: string }[]) {
  const calls: string[] = [];
  spyOn(Herdr, "plugins").mockReturnValue(OkAsync(plugins));
  spyOn(Herdr, "linkPlugin").mockImplementation((directory) => {
    calls.push(`link ${directory}`);
    return OkAsync({});
  });
  spyOn(Herdr, "unlinkPlugin").mockImplementation((id) => {
    calls.push(`unlink ${id}`);
    return OkAsync({});
  });
  return calls;
}

function data() {
  return { pluginId: "operator", manifest };
}

test("a first install writes the released manifest and links its folder", async () => {
  const calls = herdr([{ id: "other", root: `${root}/other` }]);
  expect(await installPlugin({ paths })).toEqual(
    Ok({ reason: "herdr_plugin_linked", data: data() }),
  );
  expect(await Bun.file(manifest).text()).toBe(released);
  expect(calls).toEqual([`link ${paths.herdrPlugin}`]);
});

test("a current manifest that Herdr does not link is linked", async () => {
  await Bun.write(manifest, released, { createPath: true });
  const calls = herdr([]);
  expect(await installPlugin({ paths })).toEqual(
    Ok({ reason: "herdr_plugin_linked", data: data() }),
  );
  expect(calls).toEqual([`link ${paths.herdrPlugin}`]);
});

test("an installed current manifest stays untouched", async () => {
  await Bun.write(manifest, released, { createPath: true });
  await utimes(manifest, 1, 1);
  await symlink(paths.herdrPlugin, `${root}/link`);
  const calls = herdr([{ id: "operator", root: `${root}/link` }]);
  expect(await installPlugin({ paths })).toEqual(
    Ok({ reason: "herdr_plugin_unchanged", data: data() }),
  );
  expect((await stat(manifest)).mtimeMs).toBe(1000);
  expect(calls).toEqual([]);
});

test("a changed manifest is rewritten and linked again", async () => {
  await Bun.write(manifest, "old\n", { createPath: true });
  const calls = herdr([{ id: "operator", root: paths.herdrPlugin }]);
  expect(await installPlugin({ paths })).toEqual(
    Ok({ reason: "herdr_plugin_updated", data: data() }),
  );
  expect(await Bun.file(manifest).text()).toBe(released);
  expect(calls).toEqual(["unlink operator", `link ${paths.herdrPlugin}`]);
});

test("a recorded link to a folder that is gone is restored", async () => {
  const calls = herdr([{ id: "operator", root: paths.herdrPlugin }]);
  expect(await installPlugin({ paths })).toEqual(
    Ok({ reason: "herdr_plugin_updated", data: data() }),
  );
  expect(await Bun.file(manifest).text()).toBe(released);
  expect(calls).toEqual(["unlink operator", `link ${paths.herdrPlugin}`]);
});

test.each([
  { name: "another folder", other: () => `${root}/other` },
  { name: "a missing folder", other: () => `${root}/missing` },
])("a plugin with the same id from $name is never replaced", async ({ other }) => {
  await mkdir(`${root}/other`);
  const calls = herdr([{ id: "operator", root: other() }]);
  expect(await installPlugin({ paths })).toEqual(
    Err({
      reason: "herdr_plugin_conflict",
      detail: "Herdr already links plugin operator from another directory. It was not replaced.",
    }),
  );
  expect(await Bun.file(manifest).exists()).toBe(false);
  expect(calls).toEqual([]);
});

test("a Herdr failure is returned", async () => {
  const failure = { reason: "herdr_failed" as const, detail: "failed" };
  spyOn(Herdr, "plugins").mockReturnValue(ErrAsync(failure));
  expect(await installPlugin({ paths })).toEqual(Err(failure));
  expect(await Bun.file(manifest).exists()).toBe(false);
});

test.skipIf(asRoot)("a manifest that cannot be written is a filesystem failure", async () => {
  await chmod(root, 0o500);
  const calls = herdr([]);
  expect(await installPlugin({ paths })).toMatchObject({
    tag: "Err",
    error: { reason: "dispatch_io_failed" },
  });
  expect(calls).toEqual([]);
});
