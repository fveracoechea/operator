import { expect, test } from "bun:test";
import type { ApprovalRow } from "./approvals.ts";
import { GateRun, type GateRunFacts } from "./gate-machine.ts";
import { FRESH_SERIES_ACTION, type GateRunRow, keyText } from "./gate-runs.ts";

const KEY = { tree: "tree-1", declarationIdentity: "gate-1" };

function run(overrides: Partial<GateRunRow> = {}): GateRunRow {
  return {
    id: "run-1",
    sourceId: "source-1",
    subject: JSON.stringify({ kind: "base" }),
    tree: KEY.tree,
    declarationIdentity: KEY.declarationIdentity,
    commit: "commit-1",
    commands: "[]",
    series: null,
    replaces: null,
    ownerToken: "owner",
    paneId: "w1:p1",
    state: "running",
    detail: null,
    startedAt: "2026-10-04T00:00:00.000Z",
    begunAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function approval(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: "approval-1",
    action: FRESH_SERIES_ACTION,
    targets: JSON.stringify([keyText(KEY), "run-0"]),
    scope: "source-1",
    requestRevision: keyText(KEY),
    exactText: "text",
    state: "granted",
    revision: 1,
    grantedAt: "2026-10-04T00:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

function start(overrides: Partial<GateRunFacts["start"]> = {}): GateRunFacts["start"] {
  return {
    sourceId: "source-1",
    key: KEY,
    commit: "commit-1",
    running: null,
    verdict: { status: "pending" },
    failed: [],
    approval: null,
    ...overrides,
  };
}

const COMMAND = {
  position: 0,
  outcome: "passed" as const,
  exitCode: 0,
  reason: null,
  outputPath: "out",
  outputIdentity: "identity",
};
const DECLARED = [
  { name: "lint", argv: ["bun", "run", "lint"], timeoutSeconds: 60 },
  { name: "test", argv: ["bun", "test"], timeoutSeconds: 60 },
];

test("a start replaces a run whose runner stopped and opens the approved series", () => {
  expect(
    GateRun.decide(
      "start",
      start({
        running: { run: run(), runner: { status: "stopped" } },
        verdict: { status: "failed", failed: [run({ id: "run-0", state: "failed" })] },
        failed: ["run-0"],
        approval: { id: "approval-1", row: approval() },
      }),
    ),
  ).toEqual({ next: { state: "running", replaces: "run-1", series: "approval-1" } });
});

test("a start reads its rules in order: the runner, the verdict, then the fresh series", () => {
  const passed = { status: "passed" as const, passed: [run({ id: "run-0", state: "passed" })] };
  expect(
    GateRun.decide(
      "start",
      start({
        running: { run: run(), runner: { status: "unknown", detail: "no pane" } },
        verdict: passed,
      }),
    ),
  ).toEqual({ refused: { status: "gate-runner-unknown", runId: "run-1", detail: "no pane" } });
  expect(
    GateRun.decide(
      "start",
      start({ running: { run: run(), runner: { status: "live" } }, verdict: passed }),
    ),
  ).toEqual({
    refused: {
      status: "gate-running",
      runId: "run-1",
      detail: "Gate run run-1 of this source is still running at commit commit-1.",
    },
  });
  expect(
    GateRun.decide("start", start({ verdict: passed, approval: { id: "approval-1", row: null } })),
  ).toEqual({
    refused: { status: "gate-passed", key: KEY, commit: "commit-1", runIds: ["run-0"] },
  });
  expect(
    GateRun.decide("start", start({ approval: { id: "approval-1", row: approval() } })),
  ).toEqual({ refused: { status: "fresh-series-not-needed", key: KEY } });
});

test("a fresh series needs an approval that names the key and every failed run", () => {
  const failed = start({ failed: ["run-0", "run-2"] });
  const request = {
    action: FRESH_SERIES_ACTION,
    targets: [keyText(KEY), "run-0", "run-2"],
    scope: "source-1",
    requestRevision: keyText(KEY),
  };
  const refusalOf = (row: ApprovalRow | null) =>
    GateRun.decide("start", { ...failed, approval: { id: "approval-1", row } });
  expect(refusalOf(null)).toEqual({
    refused: {
      status: "fresh-series-not-approved",
      key: KEY,
      request,
      found: "No approval approval-1 is recorded.",
    },
  });
  expect(refusalOf(approval())).toMatchObject({
    refused: { found: "Approval approval-1 does not match the targets." },
  });
  const named = JSON.stringify(request.targets);
  expect(refusalOf(approval({ targets: named, state: "revoked" }))).toMatchObject({
    refused: { found: "Approval approval-1 was revoked." },
  });
});

test("a runner begins once, and its commands are recorded in order", () => {
  expect(GateRun.decide("begin", { run: run() })).toEqual({ next: "running" });
  expect(GateRun.decide("begin", { run: run({ begunAt: "now" }) })).toEqual({
    refused: { status: "gate-run-begun", runId: "run-1" },
  });
  const begun = run({ begunAt: "now" });
  const command = { run: begun, command: COMMAND, declared: DECLARED, recorded: 0 };
  expect(GateRun.decide("command", { ...command, run: run() })).toEqual({
    refused: { status: "gate-run-not-begun", runId: "run-1" },
  });
  expect(GateRun.decide("command", { ...command, recorded: 1 })).toEqual({
    refused: { status: "gate-command-out-of-order", runId: "run-1", expected: 1, position: 0 },
  });
  expect(GateRun.decide("command", command)).toEqual({ next: "running" });
  expect(
    GateRun.decide("command", { ...command, command: { ...COMMAND, position: 1 }, recorded: 1 }),
  ).toEqual({ next: "passed" });
  expect(
    GateRun.decide("command", { ...command, command: { ...COMMAND, outcome: "failed" } }),
  ).toEqual({ next: "failed" });
});

test("a run with an outcome takes no runner write, stop, or replace", () => {
  const ended = run({ state: "passed", begunAt: "now" });
  const refused = {
    refused: { status: "gate-run-not-running" as const, runId: "run-1", state: "passed" },
  };
  expect(GateRun.decide("begin", { run: ended })).toEqual(refused);
  expect(
    GateRun.decide("command", { run: ended, command: COMMAND, declared: DECLARED, recorded: 0 }),
  ).toEqual(refused);
  expect(GateRun.decide("stop", { run: ended })).toEqual(refused);
  expect(GateRun.decide("replace", { run: ended })).toEqual(refused);
  expect(GateRun.decide("stop", { run: run() })).toEqual({ next: "stopped" });
});
