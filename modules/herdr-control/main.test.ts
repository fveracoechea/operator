import { afterEach, expect, spyOn, test } from "bun:test";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { HerdrControl } from "./main.ts";

afterEach(() => {
  spyOn(ToolInvocation, "run").mockRestore();
});

test("worktree creation groups the checkout, labels its tab and names the probe repository", async () => {
  const calls: string[][] = [];
  spyOn(ToolInvocation, "run").mockImplementation(async ({ args }) => {
    calls.push(args);
    const result =
      args[0] === "workspace" && args[1] === "create"
        ? { workspace: { workspace_id: "w-source" } }
        : args[0] === "worktree" && args[1] === "create"
          ? {
              workspace: { workspace_id: "w-child" },
              worktree: {
                path: "/projects/probe/worktree",
                branch: "probe",
                open_workspace_id: "w-child",
              },
            }
          : args[0] === "tab" && args[1] === "list"
            ? { tabs: [{ tab_id: "w-child:t1" }] }
            : {};
    return { status: "completed", exitCode: 0, stdout: JSON.stringify({ result }), stderr: "" };
  });

  const outcome = await HerdrControl.createWorktree({
    repoRoot: "/projects/probe/repo",
    path: "/projects/probe/worktree",
    branch: "probe",
    baseCommit: "base",
    label: "Renabler #59 Operative: Migrate customers",
    tabLabel: "#59 Operative: Migrate customers",
    sourceLabel: "Renabler probe 12345678 repository",
  });

  expect(outcome).toMatchObject({ status: "succeeded", value: { workspaceId: "w-child" } });
  expect(calls).toEqual([
    [
      "workspace",
      "create",
      "--cwd",
      "/projects/probe/repo",
      "--label",
      "Renabler probe 12345678 repository",
      "--no-focus",
    ],
    [
      "worktree",
      "create",
      "--workspace",
      "w-source",
      "--path",
      "/projects/probe/worktree",
      "--branch",
      "probe",
      "--base",
      "base",
      "--label",
      "Renabler #59 Operative: Migrate customers",
      "--no-focus",
    ],
    ["tab", "list", "--workspace", "w-child"],
    ["tab", "rename", "w-child:t1", "#59 Operative: Migrate customers"],
  ]);
});

test("a lost worktree creation leaves its source workspace labeled by project", async () => {
  const calls: string[][] = [];
  spyOn(ToolInvocation, "run").mockImplementation(async ({ args }) => {
    calls.push(args);
    return args[0] === "workspace"
      ? {
          status: "completed",
          exitCode: 0,
          stdout: '{"result":{"workspace":{"workspace_id":"w-source"}}}',
          stderr: "",
        }
      : { status: "no-answer", detail: "the worktree create did not answer" };
  });

  const outcome = await HerdrControl.createWorktree({
    repoRoot: "/projects/renabler/.operator/local/probe/one/repo",
    path: "/projects/renabler/.operator/local/probe/one/worktree",
    branch: "probe",
    baseCommit: "base",
    label: "Renabler probe one worktree",
    sourceLabel: "Renabler probe one repository",
  });

  expect(outcome.status).toBe("uncertain");
  expect(calls[0]).toEqual([
    "workspace",
    "create",
    "--cwd",
    "/projects/renabler/.operator/local/probe/one/repo",
    "--label",
    "Renabler probe one repository",
    "--no-focus",
  ]);
  expect(calls[1]).toContain("w-source");
  expect(calls).toHaveLength(2);
});

test("the visible agent name does not change the handle used for prompts", async () => {
  const calls: string[][] = [];
  spyOn(ToolInvocation, "run").mockImplementation(async ({ args }) => {
    calls.push(args);
    return { status: "completed", exitCode: 0, stdout: '{"result":{}}', stderr: "" };
  });

  expect(
    await HerdrControl.labelAgent({
      paneId: "w-child:p1",
      agentName: "operative-abcdef12",
      label: "#59 Operative: Migrate customers",
    }),
  ).toEqual({ status: "succeeded", value: null });
  expect(calls).toEqual([
    [
      "pane",
      "report-metadata",
      "w-child:p1",
      "--source",
      "operator",
      "--agent",
      "operative-abcdef12",
      "--display-agent",
      "#59 Operative: Migrate customers",
    ],
  ]);
});

test("a Claude Code agent with an allow list never asks, and the list closes its arguments", async () => {
  const calls: string[][] = [];
  spyOn(ToolInvocation, "run").mockImplementation(async ({ args }) => {
    calls.push(args);
    const agent = { name: args[2], pane_id: "w1:p1", agent_status: "idle" };
    return {
      status: "completed",
      exitCode: 0,
      stdout: JSON.stringify({ result: { agent } }),
      stderr: "",
    };
  });

  await HerdrControl.startAgent({
    name: "operative-1",
    kind: "claude",
    paneId: "w1:p1",
    model: "claude-sonnet-5",
    reasoningEffort: "high",
    allowedTools: ["Bash(operator attempt acknowledge:*)", "Edit(./modules/**)"],
  });
  await HerdrControl.startAgent({ name: "probe-1", kind: "claude", paneId: "w1:p1" });
  await HerdrControl.startAgent({
    name: "operative-2",
    kind: "opencode",
    paneId: "w1:p1",
    allowedTools: ["Bash(operator attempt acknowledge:*)"],
  });

  expect(calls).toEqual([
    [
      "agent",
      "start",
      "operative-1",
      "--kind",
      "claude",
      "--pane",
      "w1:p1",
      "--",
      "--model",
      "claude-sonnet-5",
      "--effort",
      "high",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      "Bash(operator attempt acknowledge:*)",
      "Edit(./modules/**)",
    ],
    ["agent", "start", "probe-1", "--kind", "claude", "--pane", "w1:p1"],
    ["agent", "start", "operative-2", "--kind", "opencode", "--pane", "w1:p1"],
  ]);
});

// Herdr 0.9.1 answers an accepted `pane run` with exit 0 and no byte on stdout or stderr.
test("a typed line that Herdr accepts with an empty answer is a success, and a lost one is not", async () => {
  const answers = [
    { exitCode: 0, stdout: "", stderr: "" },
    { exitCode: 1, stdout: "", stderr: "" },
    { exitCode: 0, stdout: "herdr: the answer was lost", stderr: "" },
    { exitCode: 1, stdout: "", stderr: '{"error":{"code":"pane_not_found","message":"gone"}}' },
  ];
  const outcomes: string[] = [];
  for (const answer of answers) {
    spyOn(ToolInvocation, "run").mockResolvedValue({ status: "completed", ...answer });
    const outcome = await HerdrControl.runInPane({ paneId: "w1:p1", line: "true" });
    outcomes.push(outcome.status === "failed" ? `failed ${outcome.code}` : outcome.status);
  }

  expect(outcomes).toEqual(["succeeded", "uncertain", "uncertain", "failed pane_not_found"]);
});
