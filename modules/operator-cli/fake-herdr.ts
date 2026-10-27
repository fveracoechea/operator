/**
 * A controlled Herdr executable for public CLI tests. It keeps its topology in one JSON file,
 * creates real Git worktrees, and runs the linked plugin manifest's hook command as Herdr does.
 * It is not evidence of the live integration, which `docs/implementation/247-dispatch.md` records.
 */
export function fakeHerdrScript(root: string) {
  return `#!${process.execPath}
const root = ${JSON.stringify(root)};
const stateFile = root + "/herdr-state.json";
const args = process.argv.slice(2);
await Bun.write(root + "/herdr-calls.jsonl", (await Bun.file(root + "/herdr-calls.jsonl").exists() ? await Bun.file(root + "/herdr-calls.jsonl").text() : "") + JSON.stringify(args) + "\\n");
const state = await Bun.file(stateFile).exists() ? await Bun.file(stateFile).json() : {};
state.workspaces ??= []; state.tabs ??= []; state.agents ??= []; state.plugins ??= []; state.counter ??= 0; state.fail ??= {};
const save = () => Bun.write(stateFile, JSON.stringify(state));
const flag = (name) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
const key = args.slice(0, 2).join(" ");
if (state.fail[key]) { console.error(JSON.stringify({ error: { message: state.fail[key] } })); process.exit(1); }
const out = (result) => console.log(JSON.stringify({ id: "cli", result }));
function pane(workspaceId) {
  state.counter++;
  const tab = { workspaceId, tabId: workspaceId + ":t" + state.counter, paneId: workspaceId + ":p" + state.counter, label: flag("--label") ?? "1" };
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
else if (key === "workspace create") { const created = workspace(flag("--cwd"), false); out({ workspace: created, root_pane: pane(created.workspace_id) }); }
else if (key === "tab list") out({ tabs: state.tabs.filter((tab) => tab.workspaceId === flag("--workspace")).map((tab) => ({ label: tab.label })) });
else if (key === "tab create") out({ root_pane: pane(flag("--workspace")) });
else if (key === "worktree create" || key === "worktree open") {
  const source = state.workspaces.find((row) => row.workspace_id === flag("--workspace"));
  const path = flag("--path") ?? root + "/herdr-home/worktrees/" + flag("--label");
  if (key === "worktree create") {
    const git = Bun.spawnSync(["git", "-C", source.worktree.checkout_path, "worktree", "add", "-q", "-b", flag("--branch"), path], { stderr: "pipe" });
    if (git.exitCode !== 0) { console.error(JSON.stringify({ error: { message: git.stderr.toString() } })); process.exit(1); }
  }
  const created = workspace(path, true);
  const rootPane = pane(created.workspace_id);
  await save();
  if (key === "worktree create") await hook("worktree.created", { event: "worktree_created", data: { type: "worktree_created", worktree: { path, branch: flag("--branch") } } });
  out({ workspace: created, root_pane: rootPane, worktree: { path, branch: flag("--branch") } });
}
else if (key === "agent list") out({ agents: state.agents.map((agent) => ({ name: agent.name, pane_id: agent.paneId })) });
else if (key === "agent start") { state.agents.push({ name: args[2], paneId: flag("--pane"), kind: flag("--kind"), args: args.slice(args.indexOf("--") + 1) }); out({ type: "agent_started" }); }
else if (key === "agent prompt") {
  const agent = state.agents.find((row) => row.name === args[2]);
  const tab = state.tabs.find((row) => row.paneId === agent?.paneId);
  // The host can end right after it takes the prompt, before dispatch records the launch.
  if (state.exitOnPrompt && tab) { await save(); await hook("pane.exited", { event: "pane_exited", data: { type: "pane_exited", pane_id: tab.paneId, workspace_id: tab.workspaceId } }); }
  out({ type: "agent_prompted" });
}
else if (key === "plugin list") out({ plugins: state.plugins.map((plugin) => ({ plugin_id: plugin.id, plugin_root: plugin.root })) });
else if (key === "plugin link") { const manifest = Bun.TOML.parse(await Bun.file(args[2] + "/herdr-plugin.toml").text()); state.plugins.push({ id: manifest.id, root: args[2] }); out({ type: "plugin_linked" }); }
else if (key === "plugin unlink") { state.plugins = state.plugins.filter((plugin) => plugin.id !== args[2]); out({ type: "plugin_unlinked" }); }
else if (key === "pane close") {
  const tab = state.tabs.find((row) => row.paneId === args[2]);
  if (!tab) { console.log(JSON.stringify({ error: { code: "pane_not_found", message: "pane " + args[2] + " not found" } })); process.exit(1); }
  state.tabs = state.tabs.filter((row) => row.paneId !== args[2]);
  state.agents = state.agents.filter((row) => row.paneId !== args[2]);
  await save();
  await hook("pane.closed", { event: "pane_closed", data: { type: "pane_closed", pane_id: args[2], workspace_id: tab.workspaceId } });
  out({ type: "pane_closed" });
}
else if (key === "pane exit") { await save(); await hook("pane.exited", { event: "pane_exited", data: { type: "pane_exited", pane_id: args[2], workspace_id: args[3] } }); }
else { console.error("unsupported " + key); process.exit(2); }
await save();
`;
}
