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
