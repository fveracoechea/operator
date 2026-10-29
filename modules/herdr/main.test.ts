import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory, permission, or recursive removal API.
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { Herdr } from "./main.ts";

const root = await mkdtemp(path.join(tmpdir(), "operator-herdr-"));
const herdr = `${root}/bin/herdr`;

/** A controlled Herdr that records its arguments and gives the answer in `answer.json`. */
const script = `#!${process.execPath}
const { appendFile } = await import("node:fs/promises");
await appendFile(${JSON.stringify(`${root}/calls.jsonl`)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const answer = await Bun.file(${JSON.stringify(`${root}/answer.json`)}).json();
if (answer.kill) process.kill(process.pid, "SIGKILL");
process.stdout.write(answer.stdout ?? "");
process.stderr.write(answer.stderr ?? "");
process.exit(answer.exit ?? 0);
`;

/** `json` is the standard output as JSON. `stdout` is raw text. */
function answer(value: {
  json?: unknown;
  stdout?: string;
  stderr?: string;
  exit?: number;
  kill?: boolean;
}) {
  const stdout = value.json === undefined ? value.stdout : JSON.stringify(value.json);
  return Bun.write(`${root}/answer.json`, JSON.stringify({ ...value, stdout }));
}

async function calls() {
  const file = Bun.file(`${root}/calls.jsonl`);
  if (!(await file.exists())) return [];
  return (await file.text())
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as unknown);
}

const pane = { pane_id: "p1", tab_id: "t1", workspace_id: "w2" };

beforeEach(async () => {
  await Bun.write(herdr, script, { createPath: true });
  await chmod(herdr, 0o755);
  await rm(`${root}/calls.jsonl`, { force: true });
  // Only the controlled Herdr is on the path, so no test can reach a real Herdr.
  spyOn(Environment, "read").mockReturnValue({ ...Environment.read(), PATH: `${root}/bin` });
});
afterEach(() => {
  mock.restore();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("lists workspaces with their checkouts, and a workspace without a worktree has none", async () => {
  await answer({
    json: {
      result: {
        workspaces: [
          {
            workspace_id: "w1",
            label: "one",
            worktree: { checkout_path: "/repo", is_linked_worktree: false },
          },
          {
            workspace_id: "w2",
            label: "two",
            worktree: { checkout_path: "/wt", is_linked_worktree: true },
          },
          { workspace_id: "w3", label: "three" },
        ],
      },
    },
  });
  expect(await Herdr.workspaces()).toMatchObject({
    tag: "Ok",
    value: [
      { workspaceId: "w1", label: "one", checkout: "/repo", linked: false },
      { workspaceId: "w2", label: "two", checkout: "/wt", linked: true },
      { workspaceId: "w3", label: "three", checkout: null, linked: false },
    ],
  });
  expect(await calls()).toEqual([["workspace", "list"]]);
});

test("creates a workspace without focus and returns its root pane", async () => {
  await answer({ json: { result: { root_pane: pane, workspace: { workspace_id: "w2" } } } });
  expect(await Herdr.createWorkspace({ cwd: "/repo", label: "one" })).toMatchObject({
    tag: "Ok",
    value: { workspaceId: "w2", tabId: "t1", paneId: "p1" },
  });
  expect(await calls()).toEqual([
    ["workspace", "create", "--cwd", "/repo", "--label", "one", "--no-focus"],
  ]);
});

test("lists tab labels and creates a tab in a workspace", async () => {
  await answer({ json: { result: { tabs: [{ label: "a" }, { label: "b" }] } } });
  expect(await Herdr.tabLabels("w1")).toMatchObject({ tag: "Ok", value: ["a", "b"] });
  await answer({ json: { result: { root_pane: pane } } });
  expect(await Herdr.createTab({ workspaceId: "w1", cwd: "/repo", label: "pr-1" })).toMatchObject({
    tag: "Ok",
    value: { tabId: "t1", paneId: "p1" },
  });
  expect(await calls()).toEqual([
    ["tab", "list", "--workspace", "w1"],
    ["tab", "create", "--workspace", "w1", "--cwd", "/repo", "--label", "pr-1", "--no-focus"],
  ]);
});

test("creates a worktree at a base commit only when one is given, and opens a worktree", async () => {
  await answer({
    json: {
      result: {
        root_pane: pane,
        workspace: { workspace_id: "w2" },
        worktree: { path: "/wt/pr-1", branch: "task/1" },
      },
    },
  });
  const placed = { workspaceId: "w2", tabId: "t1", paneId: "p1", path: "/wt/pr-1" };
  expect(
    await Herdr.createWorktree({ workspaceId: "w1", branch: "task/1", label: "pr-1" }),
  ).toMatchObject({ tag: "Ok", value: placed });
  expect(
    await Herdr.createWorktree({ workspaceId: "w1", branch: "task/1", label: "pr-1", base: "abc" }),
  ).toMatchObject({ tag: "Ok", value: placed });
  await answer({ json: { result: { root_pane: pane, workspace: { workspace_id: "w2" } } } });
  expect(
    await Herdr.openWorktree({ workspaceId: "w1", path: "/wt/pr-1", label: "pr-1" }),
  ).toMatchObject({ tag: "Ok", value: { workspaceId: "w2", tabId: "t1", paneId: "p1" } });
  const create = ["worktree", "create", "--workspace", "w1", "--branch", "task/1"];
  const tail = ["--label", "pr-1", "--no-focus"];
  expect(await calls()).toEqual([
    [...create, ...tail],
    [...create, "--base", "abc", ...tail],
    ["worktree", "open", "--workspace", "w1", "--path", "/wt/pr-1", ...tail],
  ]);
});

test("lists only named agents, starts an agent, and prompts it", async () => {
  await answer({
    json: { result: { agents: [{ name: "pr-1" }, { name: null }, {}, { name: "" }] } },
  });
  expect(await Herdr.agentNames()).toMatchObject({ tag: "Ok", value: ["pr-1"] });
  await answer({ json: { type: "agent_started" } });
  expect(
    await Herdr.startAgent({ name: "pr-1", kind: "claude", paneId: "p1", args: ["--a", "b"] }),
  ).toMatchObject({ tag: "Ok", value: { type: "agent_started" } });
  expect(await Herdr.prompt({ name: "pr-1", text: "Read it." })).toMatchObject({ tag: "Ok" });
  expect(await calls()).toEqual([
    ["agent", "list"],
    [
      "agent",
      "start",
      "pr-1",
      "--kind",
      "claude",
      "--pane",
      "p1",
      "--timeout",
      "120000",
      "--",
      "--a",
      "b",
    ],
    ["agent", "prompt", "pr-1", "Read it."],
  ]);
});

test("a pane reads its placement, and a gone pane is null", async () => {
  await answer({ json: { result: { pane } } });
  expect(await Herdr.pane("p1")).toMatchObject({
    tag: "Ok",
    value: { tabId: "t1", workspaceId: "w2" },
  });
  await answer({ json: { error: { code: "pane_not_found" } }, exit: 1 });
  expect(await Herdr.pane("p1")).toMatchObject({ tag: "Ok", value: null });
  // Herdr can write the refusal on stderr.
  await answer({ stderr: JSON.stringify({ error: { code: "pane_not_found" } }), exit: 1 });
  expect(await Herdr.pane("p1")).toMatchObject({ tag: "Ok", value: null });
  expect(await calls()).toEqual([
    ["pane", "get", "p1"],
    ["pane", "get", "p1"],
    ["pane", "get", "p1"],
  ]);
});

test("another refusal of a pane read fails with the command and Herdr's message", async () => {
  await answer({ json: { error: { code: "server_busy" } }, exit: 2 });
  expect(await Herdr.pane("p1")).toMatchObject({
    tag: "Err",
    error: {
      reason: "herdr_failed",
      detail: 'herdr pane get exited 2: {"error":{"code":"server_busy"}}',
    },
  });
});

test("closing a pane reports closed, or absent when Herdr has no such pane", async () => {
  await answer({ json: { type: "ok" } });
  expect(await Herdr.closePane("p1")).toMatchObject({ tag: "Ok", value: "closed" });
  await answer({ json: { error: { code: "pane_not_found" } }, exit: 1 });
  expect(await Herdr.closePane("p1")).toMatchObject({ tag: "Ok", value: "absent" });
  expect(await calls()).toEqual([
    ["pane", "close", "p1"],
    ["pane", "close", "p1"],
  ]);
});

test("removes a worktree, with force only when asked", async () => {
  await answer({ json: { type: "worktree_removed" } });
  expect(await Herdr.removeWorktree({ workspaceId: "w2", force: false })).toMatchObject({
    tag: "Ok",
    value: undefined,
  });
  expect(await Herdr.removeWorktree({ workspaceId: "w2", force: true })).toMatchObject({
    tag: "Ok",
  });
  expect(await calls()).toEqual([
    ["worktree", "remove", "--workspace", "w2"],
    ["worktree", "remove", "--workspace", "w2", "--force"],
  ]);
});

test("lists, links, and unlinks plugins", async () => {
  await answer({ json: { result: { plugins: [{ plugin_id: "operator", plugin_root: "/p" }] } } });
  expect(await Herdr.plugins()).toMatchObject({
    tag: "Ok",
    value: [{ id: "operator", root: "/p" }],
  });
  await answer({ json: { type: "ok" } });
  expect(await Herdr.linkPlugin("/p")).toMatchObject({ tag: "Ok", value: { type: "ok" } });
  expect(await Herdr.unlinkPlugin("operator")).toMatchObject({ tag: "Ok", value: { type: "ok" } });
  expect(await calls()).toEqual([
    ["plugin", "list", "--json"],
    ["plugin", "link", "/p"],
    ["plugin", "unlink", "operator"],
  ]);
});

test("a failed command names the first two arguments and Herdr's trimmed error output", async () => {
  await answer({ stdout: "ignored", stderr: "  no server\n", exit: 3 });
  expect(await Herdr.plugins()).toMatchObject({
    tag: "Err",
    error: { reason: "herdr_failed", detail: "herdr plugin list exited 3: no server" },
  });
  await answer({ stdout: " only stdout\n", exit: 4 });
  expect(await Herdr.plugins()).toMatchObject({
    tag: "Err",
    error: { reason: "herdr_failed", detail: "herdr plugin list exited 4: only stdout" },
  });
});

test("a refusal that is not JSON fails, also where an absent pane answers null", async () => {
  await answer({ stdout: "not json", exit: 1 });
  expect(await Herdr.closePane("p1")).toMatchObject({
    tag: "Err",
    error: { reason: "herdr_failed", detail: "herdr pane close exited 1: not json" },
  });
  // A command with no absent code never answers null for an unparsed refusal.
  await answer({ stdout: "", stderr: "", exit: 1 });
  expect(await Herdr.prompt({ name: "pr-1", text: "x" })).toMatchObject({
    tag: "Err",
    error: { reason: "herdr_failed", detail: "herdr agent prompt exited 1: " },
  });
});

test("an answer that is not JSON or not the expected shape is invalid", async () => {
  for (const stdout of ["{", JSON.stringify({ result: { plugins: [{ plugin_id: "x" }] } })]) {
    await answer({ stdout });
    expect(await Herdr.plugins()).toMatchObject({
      tag: "Err",
      error: {
        reason: "herdr_invalid_response",
        detail: "herdr plugin list returned an unexpected response.",
      },
    });
  }
  await answer({ stdout: JSON.stringify({ result: {} }) });
  expect(await Herdr.pane("p1")).toMatchObject({
    tag: "Err",
    error: { reason: "herdr_invalid_response" },
  });
});

test("a process start that rejects is a defect, never a Herdr answer", async () => {
  const cause = new Error("spawn failed");
  spyOn(ToolInvocation, "run").mockRejectedValue(cause);
  expect(await Herdr.plugins()).toMatchObject({ tag: "Defect", cause });
});

test("a missing Herdr requests nothing, and a Herdr that ends with no answer stays uncertain", async () => {
  await rm(herdr);
  expect(await Herdr.agentNames()).toMatchObject({
    tag: "Err",
    error: {
      reason: "herdr_unavailable",
      detail: "herdr is not on the path, so nothing was requested.",
    },
  });
  expect(await calls()).toEqual([]);
  await Bun.write(herdr, script);
  await chmod(herdr, 0o755);
  await answer({ kill: true });
  expect(await Herdr.prompt({ name: "pr-1", text: "x" })).toMatchObject({
    tag: "Err",
    error: {
      reason: "herdr_no_answer",
      detail:
        "herdr agent ended on SIGKILL with no answer. Inspect Herdr before a retry, because the effect can exist.",
    },
  });
});
