import { afterEach, expect, spyOn, test } from "bun:test";
import { HerdrControl } from "../herdr-control/main.ts";
import { OperativeDispatch } from "./main.ts";
import { planDispatch, type Brief, type Snapshot } from "./plan.ts";

afterEach(() => {
  spyOn(HerdrControl, "createWorktree").mockRestore();
  spyOn(HerdrControl, "findRootPane").mockRestore();
  spyOn(HerdrControl, "startAgent").mockRestore();
  spyOn(HerdrControl, "labelAgent").mockRestore();
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
    rules: { submit: [], report: [] },
    gate: null,
    review: null,
    rework: null,
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

  expect(
    (await OperativeDispatch.createWorktree({ projectRoot: "/projects/renabler", plan })).status,
  ).toBe("succeeded");
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      parentWorkspaceId: "w-renabler",
      label: "Renabler #59 Operative: Migrate customers",
      tabLabel: "#59 Operative: Migrate customers",
    }),
  );
  expect((await OperativeDispatch.launch({ plan, workspaceId: "w-child" })).status).toBe(
    "succeeded",
  );
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({ name: "operative-abcdef12", paneId: "w-child:p1" }),
  );
  expect(label).toHaveBeenCalledWith({
    paneId: "w-child:p1",
    agentName: "operative-abcdef12",
    label: "#59 Operative: Migrate customers",
  });
});
