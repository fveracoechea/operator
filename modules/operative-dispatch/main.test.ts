import { afterEach, expect, spyOn, test } from "bun:test";
import { HerdrControl } from "../herdr-control/main.ts";
import { OperativeDispatch } from "./main.ts";
import { planDispatch, type Brief, type Snapshot } from "./plan.ts";

afterEach(() => {
  spyOn(HerdrControl, "createWorktree").mockRestore();
  spyOn(HerdrControl, "findRootPane").mockRestore();
  spyOn(HerdrControl, "startAgent").mockRestore();
  spyOn(HerdrControl, "labelAgent").mockRestore();
  spyOn(HerdrControl, "submitPrompt").mockRestore();
});

test("dispatch groups the worktree under the Operator and labels the launched agent", async () => {
  const snapshot: Snapshot = {
    parentWorkspaceId: "w-renabler",
    selection: { crew: { host: "opencode", model: null } },
    release: { version: "0.4.0", identity: "release" },
    lock: { name: null, state: "ready", identity: null, path: null },
    skills: { identity: "skills" },
  };
  const brief: Brief = {
    assignmentId: "assignment-stable",
    assignmentRevision: 1,
    attemptId: "abcdef12-3456-7890-abcd-ef1234567890",
    sourceId: "github",
    sourceKey: "59",
    sourceRevision: "revision",
    title: "Migrate customers",
    kind: "production",
    approvedScope: "Migrate customers.",
    acceptanceRequirements: [],
    requirementsIdentity: "requirements",
    permissions: { writePaths: [], allowedCommands: [], network: false },
    fixedInputs: [],
    planningRecords: [],
    rules: { submit: [], report: [] },
    gate: null,
    role: { kind: "production" },
  };
  const plan = planDispatch({
    projectRoot: "/projects/renabler",
    brief,
    snapshot,
    baseCommit: "base",
    branch: null,
    worktreePath: null,
    agentHost: "opencode",
    agentKind: "opencode",
  });
  const create = spyOn(HerdrControl, "createWorktree").mockResolvedValue({
    status: "succeeded",
    value: {
      workspaceId: "w-child",
      worktree: { path: plan.worktreePath, branch: plan.branch, workspaceId: "w-child" },
    },
  });
  spyOn(HerdrControl, "findRootPane").mockResolvedValue({
    status: "found",
    value: { paneId: "w-child:p1" },
  });
  const start = spyOn(HerdrControl, "startAgent").mockResolvedValue({
    status: "succeeded",
    value: { name: plan.agentName, paneId: "w-child:p1", cwd: plan.worktreePath, status: "idle" },
  });
  const label = spyOn(HerdrControl, "labelAgent").mockResolvedValue({
    status: "succeeded",
    value: null,
  });

  const stage = { projectRoot: "/projects/renabler", plan, snapshot };
  expect(
    await OperativeDispatch.perform({ ...stage, kind: "worktree_create", workspaceId: null }),
  ).toEqual({
    status: "succeeded",
    detail: `Created ${plan.worktreePath}.`,
    workspaceId: "w-child",
  });
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      parentWorkspaceId: "w-renabler",
      label: "Renabler #59 Operative: Migrate customers",
      tabLabel: "#59 Operative: Migrate customers",
    }),
  );
  expect(
    await OperativeDispatch.perform({ ...stage, kind: "agent_start", workspaceId: "w-child" }),
  ).toEqual({
    status: "succeeded",
    detail: "Started operative-abcdef12 (idle) in pane w-child:p1.",
    paneId: "w-child:p1",
  });
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({ name: "operative-abcdef12", paneId: "w-child:p1" }),
  );
  expect(label).toHaveBeenCalledWith({
    paneId: "w-child:p1",
    agentName: "operative-abcdef12",
    label: "#59 Operative: Migrate customers",
  });
});

test("perform joins a failure code to its detail and gives an unproven submission as uncertain", async () => {
  const snapshot: Snapshot = {
    selection: { crew: { host: "claude-code", model: null } },
    release: { version: "0.4.0", identity: "release" },
    lock: { name: null, state: "ready", identity: null, path: null },
    skills: { identity: "skills" },
  };
  const delivery = {
    kind: "answer_delivery" as const,
    agentName: "operative-abcdef12",
    snapshot,
    answer: {
      questionId: "q1",
      questionRevision: 1,
      attemptId: "a1",
      authority: "operator-decision",
      exactText: "Yes.",
      interpretation: { summary: "Yes.", directives: [], appliesTo: [] },
      source: null,
    },
  };
  const submit = spyOn(HerdrControl, "submitPrompt");

  submit.mockResolvedValueOnce({
    status: "succeeded",
    value: { name: "operative-abcdef12", paneId: "w-child:p1", cwd: "/w", status: "working" },
  });
  expect(await OperativeDispatch.perform(delivery)).toEqual({
    status: "succeeded",
    detail: "Submitted the answer to operative-abcdef12.",
  });
  submit.mockResolvedValueOnce({ status: "failed", code: "agent_not_found", detail: "Gone." });
  expect(await OperativeDispatch.perform(delivery)).toEqual({
    status: "failed",
    detail: "agent_not_found: Gone.",
  });
  submit.mockResolvedValueOnce({ status: "uncertain", detail: "No answer." });
  expect(await OperativeDispatch.perform(delivery)).toEqual({
    status: "uncertain",
    detail: "No answer.",
  });
});

// Crew state records each stage detail, so its bytes are pinned here, where it is worded.
test("each launch stage words its recorded detail", async () => {
  const snapshot: Snapshot = {
    selection: { crew: { host: "claude-code", model: null } },
    release: { version: "0.4.0", identity: "release" },
    lock: { name: null, state: "ready", identity: null, path: null },
    skills: { identity: "skills" },
  };
  const brief: Brief = {
    assignmentId: "assignment-stable",
    assignmentRevision: 1,
    attemptId: "abcdef12-3456-7890-abcd-ef1234567890",
    sourceId: "github",
    sourceKey: "59",
    sourceRevision: "revision",
    title: "Migrate customers",
    kind: "production",
    approvedScope: "Migrate customers.",
    acceptanceRequirements: [],
    requirementsIdentity: "requirements",
    permissions: { writePaths: [], allowedCommands: [], network: false },
    fixedInputs: [],
    planningRecords: [],
    rules: { submit: [], report: [] },
    gate: null,
    role: { kind: "production" },
  };
  const plan = planDispatch({
    projectRoot: "/projects/renabler",
    brief,
    snapshot,
    baseCommit: "base",
    branch: null,
    worktreePath: null,
    agentHost: "claude-code",
    agentKind: "claude",
  });
  const stage = { projectRoot: "/projects/renabler", plan, snapshot };
  spyOn(HerdrControl, "findRootPane").mockResolvedValue({ status: "absent" });
  spyOn(HerdrControl, "submitPrompt").mockResolvedValue({
    status: "succeeded",
    value: {
      name: plan.agentName,
      paneId: "w-child:p1",
      cwd: plan.worktreePath,
      status: "working",
    },
  });

  expect(
    await OperativeDispatch.perform({ ...stage, kind: "agent_start", workspaceId: null }),
  ).toEqual({ status: "failed", detail: "The recorded checkout names no Herdr workspace." });
  expect(
    await OperativeDispatch.perform({ ...stage, kind: "agent_start", workspaceId: "w-gone" }),
  ).toEqual({
    status: "failed",
    detail: "workspace_not_found: Herdr holds no workspace w-gone to launch in.",
  });
  expect(
    await OperativeDispatch.perform({ ...stage, kind: "prompt_delivery", workspaceId: "w-child" }),
  ).toEqual({ status: "succeeded", detail: "Submitted the brief to operative-abcdef12." });
});
