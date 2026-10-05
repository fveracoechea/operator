import { expect, test } from "bun:test";
import { OperativeDispatch } from "../operative-dispatch/main.ts";
import { Attempt, type AttemptFacts } from "./attempt-machine.ts";
import type { Brief, Inspection, Snapshot } from "./dispatch-context.ts";
import type { AttemptContext, DispatchRow, OperationRow } from "./dispatch.ts";

const SNAPSHOT: Snapshot = {
  parentWorkspaceId: "w-operator",
  selection: { crew: { host: "claude-code", model: null } },
  release: { version: "0.4.0", identity: "release" },
  lock: { name: null, state: "ready", identity: null, path: null },
  skills: { identity: "skills" },
};

const BRIEF: Brief = {
  assignmentId: "assignment-1",
  assignmentRevision: 1,
  attemptId: "attempt-1",
  sourceId: "source-1",
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

const GATE_UNUSABLE = {
  status: "project-gate-unusable" as const,
  attemptId: "attempt-1",
  gate: { status: "missing" as const, commit: "base", path: "operator-gate.json" },
};

function planned() {
  const launch = OperativeDispatch.plan({
    projectRoot: "/projects/one",
    brief: BRIEF,
    snapshot: SNAPSHOT,
    baseCommit: "base",
    branch: null,
    worktreePath: null,
  });
  if (launch.status !== "planned") {
    throw new Error("The fixture snapshot names a crew host.");
  }
  return { status: "planned" as const, brief: BRIEF, plan: launch.plan };
}

function dispatchRow(fields: Partial<DispatchRow> = {}): DispatchRow {
  return {
    attemptId: "attempt-1",
    assignmentId: "assignment-1",
    baseCommit: "base",
    branch: "operator/one",
    worktreePath: "/worktrees/one",
    snapshot: JSON.stringify(SNAPSHOT),
    snapshotIdentity: "snapshot",
    briefIdentity: "brief",
    promptIdentity: "prompt",
    agentName: "operative-one",
    agentKind: "claude",
    agentHost: "claude-code",
    workspaceId: "w-one",
    paneId: null,
    acknowledgedAt: null,
    inspection: null,
    inspectionIdentity: null,
    outsideScan: null,
    planningRecordIds: null,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    ...fields,
  };
}

function operation(kind: string, state: string): OperationRow {
  return {
    id: `operation-${kind}`,
    attemptId: "attempt-1",
    kind,
    requestId: "request-1",
    intent: "{}",
    state,
    detail: null,
    startedAt: "2026-10-03T00:00:00.000Z",
    settledAt: null,
  };
}

function contextOf(fields: Partial<AttemptContext> = {}): AttemptContext {
  return {
    attempt: {
      id: "attempt-1",
      assignmentId: "assignment-1",
      ownerToken: "owner",
      state: "active",
      revision: 1,
      startedAt: "2026-10-03T00:00:00.000Z",
      endedAt: null,
    },
    assignment: {
      id: "assignment-1",
      sourceId: "source-1",
      sourceKey: "59",
      sourceRevision: "revision",
      trackerBinding: null,
      title: "Migrate customers",
      kind: "production",
      planningType: null,
      orderIndex: 0,
      approvedScope: "Migrate customers.",
      scopeIdentity: null,
      acceptanceRequirements: "[]",
      permissions: "{}",
      fixedInputs: "[]",
      fixedInputsIdentity: "inputs",
      state: "claimed",
      revision: 1,
      registeredAt: "2026-10-03T00:00:00.000Z",
      updatedAt: "2026-10-03T00:00:00.000Z",
      withdrawnUnder: null,
    },
    dispatch: null,
    operations: [],
    role: { kind: "production" },
    planning: { launched: null, latest: [] },
    writePaths: [],
    attemptsHeld: 1,
    current: true,
    ...fields,
  };
}

const STOPPED: Inspection = {
  writer: { state: "stopped" },
  checkout: { state: "present" },
  work: {
    worktreePath: "/worktrees/one",
    present: true,
    branch: "operator/one",
    head: "head",
    uncommitted: [],
    commits: [],
    identity: "inspection-1",
  },
};

function newDispatch(fields: Partial<AttemptFacts["dispatch"]> = {}): AttemptFacts["dispatch"] {
  return {
    context: contextOf(),
    attemptId: "attempt-1",
    requested: { baseCommit: "base", branch: null, worktreePath: null },
    ...fields,
  };
}

function replacement(fields: Partial<AttemptFacts["replace"]> = {}): AttemptFacts["replace"] {
  return {
    context: contextOf({ dispatch: dispatchRow() }),
    attemptId: "attempt-1",
    launchAttemptId: "attempt-2",
    approvedInspection: "inspection-1",
    inspection: STOPPED,
    ...fields,
  };
}

test("a new dispatch reads each fact in the order of the table", () => {
  expect(Attempt.decide("dispatch", newDispatch())).toEqual({ need: "parent" });

  const parent = { status: "found" as const, value: { workspaceId: "w-operator" } };
  expect(Attempt.decide("dispatch", newDispatch({ parent }))).toEqual({ need: "current" });
  expect(Attempt.decide("dispatch", newDispatch({ parent, current: SNAPSHOT }))).toEqual({
    need: "integration",
  });

  const integration = { status: "ok" as const, start: null };
  expect(
    Attempt.decide("dispatch", newDispatch({ parent, current: SNAPSHOT, integration })),
  ).toEqual({ need: "skills", baseCommit: "base", agentHost: "claude-code" });

  // The launch snapshot names each skill copy the launch keeps from its commit.
  const committed = [{ path: ".claude/skills/operative/SKILL.md", identity: "crew" }];
  const skills = { status: "ok" as const, committed };
  const snapshot = { ...SNAPSHOT, skills: { identity: "skills", committed } };
  const read = { parent, current: SNAPSHOT, integration, skills };
  expect(Attempt.decide("dispatch", newDispatch(read))).toEqual({
    need: "launch",
    snapshot,
    baseCommit: "base",
    branch: null,
    worktreePath: null,
  });

  const launch = planned();
  expect(Attempt.decide("dispatch", newDispatch({ ...read, launch }))).toEqual({
    need: "base",
    baseCommit: "base",
  });

  const base = { status: "ok" as const, base: null };
  expect(Attempt.decide("dispatch", newDispatch({ ...read, launch, base }))).toEqual({
    next: "active",
    launch: {
      snapshot,
      baseCommit: "base",
      brief: BRIEF,
      plan: launch.plan,
      passed: null,
    },
  });
});

test("a dispatch outside a Herdr pane is refused before the snapshot is read", () => {
  expect(Attempt.decide("dispatch", newDispatch({ parent: null }))).toEqual({
    refused: {
      status: "workspace-required",
      attemptId: "attempt-1",
      detail: "This command is not running in a Herdr pane.",
    },
  });
});

test("a dispatch refuses an unusable brief gate before it reads the base gate", () => {
  const facts = newDispatch({
    parent: { status: "found", value: { workspaceId: "w-operator" } },
    current: SNAPSHOT,
    integration: { status: "ok", start: null },
    skills: { status: "ok", committed: [] },
    launch: GATE_UNUSABLE,
  });
  expect(Attempt.decide("dispatch", facts)).toEqual({ refused: GATE_UNUSABLE });
});

test("a dispatch refuses a base gate that did not pass before a host it cannot name", () => {
  const base = {
    status: "base-gate-not-passed" as const,
    attemptId: "attempt-1",
    gate: "gate_pending" as const,
    commit: "base",
    key: { tree: "tree", declarationIdentity: "declaration" },
    runIds: [],
  };
  const facts = newDispatch({
    parent: { status: "found", value: { workspaceId: "w-operator" } },
    current: SNAPSHOT,
    integration: { status: "ok", start: null },
    skills: { status: "ok", committed: [] },
    launch: { status: "host-unnamed" },
    base,
  });
  expect(Attempt.decide("dispatch", facts)).toEqual({ refused: base });
  expect(Attempt.decide("dispatch", { ...facts, base: { status: "ok", base: null } })).toEqual({
    refused: { status: "host-unnamed", attemptId: "attempt-1" },
  });
});

test("a finished launch repeats what it recorded", () => {
  const operations = ["worktree_create", "input_preparation", "agent_start", "prompt_delivery"].map(
    (kind) => operation(kind, "succeeded"),
  );
  const dispatch = dispatchRow();
  expect(
    Attempt.decide("dispatch", newDispatch({ context: contextOf({ dispatch, operations }) })),
  ).toEqual({ next: "active", repeated: "awaiting-acknowledgement", dispatch });
});

test("a replacement reports a launch with no crew host as a snapshot it cannot read", () => {
  expect(Attempt.decide("replace", replacement({ launch: { status: "host-unnamed" } }))).toEqual({
    refused: {
      status: "snapshot-unreadable",
      attemptId: "attempt-1",
      detail: "The recorded snapshot names no crew host.",
    },
  });
  expect(
    Attempt.decide(
      "replace",
      replacement({ launch: { status: "effort-unsupported", detail: "No effort." } }),
    ),
  ).toEqual({
    refused: { status: "snapshot-unreadable", attemptId: "attempt-1", detail: "No effort." },
  });
});

test("a replacement plans the brief of the new attempt and names the replaced one", () => {
  expect(Attempt.decide("replace", replacement())).toEqual({
    need: "launch",
    snapshot: SNAPSHOT,
    dispatch: dispatchRow(),
  });
  expect(Attempt.decide("replace", replacement({ launch: GATE_UNUSABLE }))).toEqual({
    refused: GATE_UNUSABLE,
  });
});

test("a replacement settles every effect before it reads the writer", () => {
  const context = contextOf({
    dispatch: dispatchRow(),
    operations: [operation("agent_start", "uncertain")],
  });
  expect(Attempt.decide("replace", replacement({ context, inspection: undefined }))).toEqual({
    refused: {
      status: "reconciliation-required",
      attemptId: "attempt-1",
      pending: ["agent_start"],
    },
  });
});

test("a replacement needs the exact inspection the caller approved", () => {
  expect(Attempt.decide("replace", replacement({ approvedInspection: null }))).toEqual({
    refused: { status: "inspection-required", attemptId: "attempt-1", inspection: STOPPED.work },
  });
  expect(Attempt.decide("replace", replacement({ approvedInspection: "older" }))).toEqual({
    refused: {
      status: "inspection-stale",
      attemptId: "attempt-1",
      inspection: STOPPED.work,
      approved: "older",
    },
  });
});

test("only an unsettled input copy runs again in place", () => {
  expect(Attempt.step("input_preparation", operation("input_preparation", "intended"))).toEqual({
    run: "resume",
    operation: operation("input_preparation", "intended"),
  });
  expect(Attempt.step("agent_start", operation("agent_start", "intended"))).toEqual({
    run: "reconcile",
    operationState: "intended",
  });
  expect(Attempt.step("agent_start", null)).toEqual({ run: "open", scansOutside: true });
  expect(Attempt.step("worktree_create", operation("worktree_create", "succeeded"))).toEqual({
    run: "skip",
  });
});

test("the launch state reads the plan, the stages, and the acknowledgement", () => {
  const succeeded = ["worktree_create", "input_preparation", "agent_start", "prompt_delivery"].map(
    (kind) => operation(kind, "succeeded"),
  );
  expect(Attempt.launchState(null, [])).toBe("unplanned");
  expect(Attempt.launchState(dispatchRow(), succeeded.slice(0, 3))).toBe("launching");
  expect(Attempt.launchState(dispatchRow(), succeeded)).toBe("awaiting-acknowledgement");
  expect(Attempt.launchState(dispatchRow({ acknowledgedAt: "now" }), succeeded)).toBe(
    "acknowledged",
  );
});

test("a writer command refuses an attempt that never acknowledged its brief", () => {
  const facts = { attemptId: "attempt-1", worktreePath: "/worktrees/one", dispatch: dispatchRow() };
  expect(Attempt.readWriter(facts)).toEqual({
    refused: { status: "not-acknowledged", attemptId: "attempt-1" },
  });
  expect(Attempt.decide("acknowledge", { ...facts, worktreePath: "/elsewhere" })).toEqual({
    refused: {
      status: "reference-mismatch",
      attemptId: "attempt-1",
      detail: "This attempt is recorded against /worktrees/one.",
    },
  });
});

function submission(fields: Partial<AttemptFacts["submit"]> = {}): AttemptFacts["submit"] {
  const { assignment } = contextOf();
  return {
    attemptId: "attempt-1",
    assignment,
    stated: { assignmentRevision: 1, sourceRevision: "revision", requirementsIdentity: "req" },
    requirementsIdentity: "req",
    held: null,
    ...fields,
  };
}

test("a submit ends the attempt as submitted", () => {
  expect(Attempt.decide("submit", submission())).toEqual({ next: "submitted" });
});

test("a submit refuses in the order of its table", () => {
  const { assignment } = contextOf();
  const stated = { assignmentRevision: 2, sourceRevision: "other", requirementsIdentity: "old" };
  const held = { id: "submission-1" };
  expect(
    Attempt.decide(
      "submit",
      submission({ assignment: { ...assignment, kind: "review" }, stated, held }),
    ),
  ).toEqual({ refused: { status: "review-result-not-submitted", assignmentId: "assignment-1" } });
  expect(
    Attempt.decide("submit", submission({ assignment: { ...assignment, kind: "planning" }, held })),
  ).toEqual({
    refused: { status: "planning-only", assignmentId: "assignment-1", kind: "planning" },
  });
  expect(
    Attempt.decide("submit", submission({ assignment: { ...assignment, state: "ready" }, stated })),
  ).toEqual({ refused: { status: "not-claimed", assignmentId: "assignment-1", state: "ready" } });
  expect(Attempt.decide("submit", submission({ stated, held }))).toEqual({
    refused: { status: "stale-revision", assignmentId: "assignment-1", recordedRevision: 1 },
  });
  expect(
    Attempt.decide("submit", submission({ stated: { ...stated, assignmentRevision: 1 }, held })),
  ).toEqual({
    refused: {
      status: "source-revision-changed",
      assignmentId: "assignment-1",
      recordedRevision: "revision",
    },
  });
  expect(
    Attempt.decide(
      "submit",
      submission({
        stated: { assignmentRevision: 1, sourceRevision: "revision", requirementsIdentity: "old" },
        held,
      }),
    ),
  ).toEqual({
    refused: {
      status: "requirements-changed",
      assignmentId: "assignment-1",
      recordedIdentity: "req",
    },
  });
  expect(Attempt.decide("submit", submission({ held }))).toEqual({
    refused: { status: "already-submitted", attemptId: "attempt-1", submissionId: "submission-1" },
  });
});
