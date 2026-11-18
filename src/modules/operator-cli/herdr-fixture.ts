// Bun has no temporary-directory API.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A controlled Herdr executable for public CLI tests. It keeps its topology in one JSON file,
 * creates real Git worktrees, and runs the linked plugin manifest's hook command as Herdr does.
 * It is not evidence of the live integration.
 */
export function fakeHerdrScript(root: string) {
  return `#!${process.execPath}
const root = ${JSON.stringify(root)};
const stateFile = root + "/herdr-state.json";
const args = process.argv.slice(2);
// A rewrite would let a concurrent reader see a truncated log, so each call appends one line.
const { appendFile } = await import("node:fs/promises");
await appendFile(root + "/herdr-calls.jsonl", JSON.stringify(args) + "\\n");
const key = args.slice(0, 2).join(" ");
const readOnly = ["workspace list", "tab list", "pane list", "agent list", "plugin list", "pane get"].includes(key);
const { Database } = await import("bun:sqlite");
// SQLite owns process-death recovery. Keep the JSON shape used by fixture consumers.
let lock = readOnly ? null : new Database(root + "/herdr-state-lock.sqlite");
if (lock) { lock.run("PRAGMA busy_timeout = 5000"); lock.run("BEGIN IMMEDIATE"); }
const state = await Bun.file(stateFile).exists() ? await Bun.file(stateFile).json() : {};
state.workspaces ??= []; state.tabs ??= []; state.agents ??= []; state.plugins ??= []; state.counter ??= 0; state.fail ??= {};
// Bun has no atomic file-replacement API. Readers must see complete snapshots without taking the writer lock.
const { appendFileSync, existsSync, statSync, writeFileSync, renameSync } = await import("node:fs");
function trace(phase) {
  const file = root + "/herdr-topology.jsonl";
  const target = ["pane get", "pane close", "pane exit", "tab rename"].includes(key) ? args[2] : null;
  const id = (value) => typeof value === "string" && /^[a-z0-9:.-]{1,80}$/i.test(value) ? value : null;
  const record = JSON.stringify({ phase, pid: process.pid, fixture: root, session: root + "/herdr.sock", command: key,
    target: id(target), counter: state.counter, workspaceCount: state.workspaces.length, tabCount: state.tabs.length,
    workspaces: state.workspaces.slice(0, 32).map((row) => id(row.workspace_id)),
    tabs: state.tabs.slice(0, 32).map((row) => ({ tabId: id(row.tabId), paneId: id(row.paneId), workspaceId: id(row.workspaceId) })) }) + "\\n";
  // Append-only order exposes stale snapshots without logging labels, prompts, or host environment.
  if ((existsSync(file) ? statSync(file).size : 0) + Buffer.byteLength(record) <= 262144) appendFileSync(file, record);
}
trace("loaded");
const save = async () => {
  if (!lock) return;
  trace("save-start");
  const temporary = stateFile + "." + process.pid;
  writeFileSync(temporary, JSON.stringify(state));
  renameSync(temporary, stateFile);
  trace("save-end");
  lock.run("COMMIT"); lock.close(); lock = null;
};
const flag = (name) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
if (state.fail[key]) { console.error(JSON.stringify({ error: { message: state.fail[key] } })); process.exit(1); }
const out = (result) => console.log(JSON.stringify({ id: "cli", result }));
// Herdr labels only a tab it creates with \`tab create\`. A workspace's root tab shows its number.
function pane(workspaceId, cwd, label = "1") {
  state.counter++;
  const tab = { workspaceId, tabId: workspaceId + ":t" + state.counter, paneId: workspaceId + ":p" + state.counter, label, cwd };
  state.tabs.push(tab);
  return { pane_id: tab.paneId, tab_id: tab.tabId, workspace_id: workspaceId };
}
function workspace(checkout, linked) {
  state.counter++;
  const created = { workspace_id: "w" + state.counter, label: flag("--label") ?? "workspace", worktree: { checkout_path: checkout, is_linked_worktree: linked } };
  state.workspaces.push(created);
  return created;
}
async function hook(event, data) {
  if (state.skipHooks) return;
  for (const plugin of state.plugins) {
    const manifest = Bun.TOML.parse(await Bun.file(plugin.root + "/herdr-plugin.toml").text());
    for (const entry of manifest.events ?? []) {
      if (entry.on !== event) continue;
      const child = Bun.spawn(entry.command, { cwd: plugin.root, env: { ...process.env, HERDR_PLUGIN_EVENT: event, HERDR_PLUGIN_EVENT_JSON: JSON.stringify(data) }, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      await Bun.write(root + "/herdr-hooks.jsonl", (await Bun.file(root + "/herdr-hooks.jsonl").exists() ? await Bun.file(root + "/herdr-hooks.jsonl").text() : "") + JSON.stringify({ event, code, stdout, stderr }) + "\\n");
    }
  }
}
if (key === "workspace list") out({ workspaces: state.workspaces });
else if (key === "workspace create") { const created = workspace(flag("--cwd"), false); out({ workspace: created, root_pane: pane(created.workspace_id, flag("--cwd")) }); }
else if (key === "tab list") out({ tabs: state.tabs.filter((tab) => tab.workspaceId === flag("--workspace")).map((tab) => ({ label: tab.label })) });
else if (key === "tab create") out({ root_pane: pane(flag("--workspace"), flag("--cwd"), flag("--label") ?? "1") });
else if (key === "tab rename") { const tab = state.tabs.find((row) => row.tabId === args[2]); if (!tab) { trace("tab-not-found"); console.log(JSON.stringify({ error: { code: "tab_not_found", message: "tab " + args[2] + " not found" } })); process.exit(1); } tab.label = args.slice(3).join(" "); out({ type: "tab_renamed" }); }
else if (key === "pane list") out({ panes: state.tabs.map((tab) => ({ pane_id: tab.paneId, tab_id: tab.tabId, workspace_id: tab.workspaceId, cwd: tab.cwd })) });
else if (key === "worktree create" || key === "worktree open") {
  const source = state.workspaces.find((row) => row.workspace_id === flag("--workspace"));
  const path = flag("--path") ?? root + "/herdr-home/worktrees/" + flag("--label");
  if (key === "worktree create") {
    const git = Bun.spawnSync(["git", "-C", source.worktree.checkout_path, "worktree", "add", "-q", "-b", flag("--branch"), path, ...(flag("--base") ? [flag("--base")] : [])], { stderr: "pipe" });
    if (git.exitCode !== 0) { console.error(JSON.stringify({ error: { message: git.stderr.toString() } })); process.exit(1); }
  }
  const created = workspace(path, true);
  const rootPane = pane(created.workspace_id, path);
  await save();
  if (key === "worktree create") await hook("worktree.created", { event: "worktree_created", data: { type: "worktree_created", worktree: { path, branch: flag("--branch") } } });
  out({ workspace: created, root_pane: rootPane, worktree: { path, branch: flag("--branch") } });
}
else if (key === "agent list") out({ agents: state.agents.map((agent) => ({ name: agent.name, pane_id: agent.paneId })) });
else if (key === "agent start") { state.agents.push({ name: args[2], paneId: flag("--pane"), kind: flag("--kind"), args: args.slice(args.indexOf("--") + 1) }); out({ type: "agent_started" }); }
else if (key === "agent rename") { const agent = state.agents.find((row) => row.paneId === args[2]); if (!agent) { console.log(JSON.stringify({ error: { code: "agent_not_found", message: "No agent in pane" } })); process.exit(1); } agent.name = args[3]; out({ type: "agent_renamed" }); }
else if (key === "agent prompt") {
  const agent = state.agents.find((row) => row.name === args[2]);
  const tab = state.tabs.find((row) => row.paneId === agent?.paneId);
  // The host can end right after it takes the prompt, before dispatch records the launch.
  // A delay keeps a prompting process alive, so a test can act while it runs.
  if (state.promptDelayMs) await Bun.sleep(state.promptDelayMs);
  if (state.exitOnPrompt && tab) { await save(); await hook("pane.exited", { event: "pane_exited", data: { type: "pane_exited", pane_id: tab.paneId, workspace_id: tab.workspaceId } }); }
  out({ type: "agent_prompted" });
}
else if (key === "plugin list") out({ plugins: state.plugins.map((plugin) => ({ plugin_id: plugin.id, plugin_root: plugin.root })) });
else if (key === "plugin link") { const manifest = Bun.TOML.parse(await Bun.file(args[2] + "/herdr-plugin.toml").text()); state.plugins.push({ id: manifest.id, root: args[2] }); out({ type: "plugin_linked" }); }
else if (key === "plugin unlink") { state.plugins = state.plugins.filter((plugin) => plugin.id !== args[2]); out({ type: "plugin_unlinked" }); }
else if (key === "pane get" || key === "pane close") {
  const tab = state.tabs.find((row) => row.paneId === args[2]);
  if (!tab) { console.log(JSON.stringify({ error: { code: "pane_not_found", message: "pane " + args[2] + " not found" } })); process.exit(1); }
  if (key === "pane get") out({ pane: { pane_id: tab.paneId, tab_id: tab.tabId, workspace_id: tab.workspaceId } });
  else {
    // Herdr closes the workspace with its last pane, as the live check observed.
    state.tabs = state.tabs.filter((row) => row !== tab);
    state.agents = state.agents.filter((agent) => agent.paneId !== tab.paneId);
    if (!state.tabs.some((row) => row.workspaceId === tab.workspaceId)) state.workspaces = state.workspaces.filter((row) => row.workspace_id !== tab.workspaceId);
    await save();
    await hook("pane.closed", { event: "pane_closed", data: { type: "pane_closed", pane_id: tab.paneId, workspace_id: tab.workspaceId } });
    out({ type: "ok" });
  }
}
else if (key === "worktree remove") {
  const workspace = state.workspaces.find((row) => row.workspace_id === flag("--workspace"));
  if (!workspace) { console.log(JSON.stringify({ error: { code: "workspace_not_found", message: "workspace not found" } })); process.exit(1); }
  const path = workspace.worktree.checkout_path;
  const common = Bun.spawnSync(["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"], { stdout: "pipe" }).stdout.toString().trim();
  const git = Bun.spawnSync(["git", "-C", common.slice(0, -"/.git".length), "worktree", "remove", ...(args.includes("--force") ? ["--force"] : []), path], { stderr: "pipe" });
  if (git.exitCode !== 0) { console.log(JSON.stringify({ error: { code: "dirty_worktree_requires_force", message: git.stderr.toString() } })); process.exit(1); }
  state.workspaces = state.workspaces.filter((row) => row !== workspace);
  state.tabs = state.tabs.filter((row) => row.workspaceId !== workspace.workspace_id);
  out({ type: "worktree_removed", path, workspace_id: workspace.workspace_id, forced: args.includes("--force") });
}
else if (key === "pane exit") { await save(); await hook("pane.exited", { event: "pane_exited", data: { type: "pane_exited", pane_id: args[2], workspace_id: args[3] } }); }
else { console.error("unsupported " + key); process.exit(2); }
// Save once, releasing before hooks that can call this executable again.
// A post-hook save would overwrite mutations made while the hook was running.
await save();
`;
}

/** Retain only sanitized topology before the device's afterEach removes its root. */
export async function retainHerdrTrace(root: string) {
  const trace = Bun.file(`${root}/herdr-topology.jsonl`);
  if (!(await trace.exists())) return null;
  const directory = await mkdtemp(path.join(tmpdir(), "operator-herdr-failure-"));
  const file = `${directory}/herdr-topology.jsonl`;
  const text = await trace.slice(0, 262144).text();
  await Bun.write(file, text);
  return { file, tail: text.slice(-16384) };
}
