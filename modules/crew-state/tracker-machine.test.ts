import { describe, expect, test } from "bun:test";
import type { ApprovalRow } from "./approvals.ts";
import type { TrackerOperationRow, TrackerWriteRow } from "./tracker.ts";
import { TrackerStep } from "./tracker-machine.ts";

const NOW = "2026-10-04T00:00:00.000Z";
const TARGET = { repository: "fveracoechea/operator", issue: 7 };

function operation(fields: Partial<TrackerOperationRow> = {}): TrackerOperationRow {
  return {
    id: "operation-1",
    assignmentId: "assignment-1",
    step: "resolution",
    provider: "github",
    target: JSON.stringify(TARGET),
    expectedActor: "operator-bot",
    intent: "{}",
    intentIdentity: "intent-1",
    content: "body",
    contentIdentity: null,
    closeReason: null,
    state: "intended",
    reason: "tracker.pending",
    problems: "[]",
    resourceId: null,
    resourceUrl: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...fields,
  };
}

function attempt(fields: Partial<TrackerWriteRow> = {}): TrackerWriteRow {
  return {
    id: "attempt-1",
    operationId: "operation-1",
    requestId: "request-1",
    approvalId: null,
    state: "uncertain",
    response: null,
    startedAt: NOW,
    settledAt: NOW,
    ...fields,
  };
}

const CHECK = {
  action: "tracker.additional_write",
  targets: [`github:${TARGET.repository}#${TARGET.issue}`, "operation:operation-1"],
  scope: "resolution",
  requestRevision: "1",
};

function approval(fields: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: "approval-1",
    action: CHECK.action,
    targets: JSON.stringify(CHECK.targets),
    scope: CHECK.scope,
    requestRevision: CHECK.requestRevision,
    exactText: "text",
    state: "granted",
    revision: 1,
    grantedAt: NOW,
    revokedAt: null,
    ...fields,
  };
}

/** The gate facts of a step whose one sent write has no proven outcome. */
function unproven(fields: { approvalId?: string | null; approval?: ApprovalRow | null } = {}) {
  return {
    operation: operation({ state: "uncertain", reason: "tracker.resolution_outcome_unknown" }),
    attempts: [attempt()],
    target: TARGET,
    approvalId: fields.approvalId ?? null,
    approval: fields.approval ?? null,
  };
}

describe("TrackerStep.read", () => {
  test("offers what each state needs, and nothing for a step with no target", () => {
    const offered = Object.fromEntries(
      ["intended", "pending", "verified", "conflict", "uncertain", "failed"].map((state) => [
        state,
        TrackerStep.read({ applicable: true, operation: operation({ state }) }).actions,
      ]),
    );

    expect(TrackerStep.read({ applicable: true, operation: null })).toEqual({
      state: "unrecorded",
      actions: ["record"],
    });
    expect(offered).toEqual({
      intended: ["recover", "record"],
      pending: ["recover", "record"],
      verified: [],
      conflict: ["user"],
      uncertain: ["recover", "approved-write"],
      failed: ["record"],
    });
    expect(TrackerStep.read({ applicable: false, operation: null })).toEqual({
      state: "unrecorded",
      actions: [],
    });
  });

  test("fails loudly on a recorded state this release does not know", () => {
    expect(() =>
      TrackerStep.read({ applicable: true, operation: operation({ state: "done" }) }),
    ).toThrow(
      new Error("the crew state holds a tracker step state this release cannot read: done"),
    );
  });
});

describe("TrackerStep.decide", () => {
  test("open plans a new operation, resumes a held one, and never writes a verified one again", () => {
    const held = operation();

    expect(TrackerStep.decide("open", { operation: null, intentIdentity: "intent-1" })).toEqual({
      next: { stage: "plan" },
    });
    expect(TrackerStep.decide("open", { operation: held, intentIdentity: "intent-1" })).toEqual({
      next: { stage: "resume", operation: held },
    });
    // A verified step reports before its content is compared, so changed content is not refused.
    expect(
      TrackerStep.decide("open", {
        operation: operation({ state: "verified" }),
        intentIdentity: "intent-2",
      }),
    ).toEqual({ next: { stage: "report", operationId: "operation-1" } });
  });

  test("open refuses changed content under one operation", () => {
    expect(
      TrackerStep.decide("open", { operation: operation(), intentIdentity: "intent-2" }),
    ).toEqual({
      refused: {
        status: "content-changed",
        operationId: "operation-1",
        recorded: "intent-1",
        stated: "intent-2",
      },
    });
  });

  test("observe reads before a completion and before any step that already sent a write", () => {
    expect(TrackerStep.decide("observe", { operation: operation(), attempts: [] })).toEqual({
      next: "write",
    });
    expect(
      TrackerStep.decide("observe", { operation: operation({ step: "completion" }), attempts: [] }),
    ).toEqual({ next: "read" });
    expect(
      TrackerStep.decide("observe", { operation: operation(), attempts: [attempt()] }),
    ).toEqual({
      next: "read",
    });
  });

  test("gate writes again only after nothing was observed or the tracker refused the request", () => {
    for (const reason of ["tracker.pending", "tracker.write_rejected"]) {
      expect(
        TrackerStep.decide("gate", { ...unproven(), operation: operation({ reason }) }),
      ).toEqual({ next: "write" });
    }
    expect(
      TrackerStep.decide("gate", {
        ...unproven(),
        operation: operation({ state: "verified", reason: "tracker.completed" }),
      }),
    ).toEqual({ next: "report" });
    // An unknown outcome with no sent write has no earlier effect to accept the risk of.
    expect(
      TrackerStep.decide("gate", { ...unproven(), attempts: [attempt({ state: "intended" })] }),
    ).toEqual({ next: "report" });
  });

  test("gate holds an unproven write for an approval, in the order of its refusals", () => {
    expect(TrackerStep.decide("gate", unproven({ approvalId: "approval-9" }))).toEqual({
      refused: { reason: "unknown-approval", approvalId: "approval-9" },
    });
    expect(TrackerStep.decide("gate", unproven())).toEqual({
      refused: { reason: "approval-required", ...CHECK },
    });
    expect(
      TrackerStep.decide(
        "gate",
        unproven({ approvalId: "approval-1", approval: approval({ requestRevision: "0" }) }),
      ),
    ).toEqual({
      refused: { reason: "approval-mismatch", approvalId: "approval-1", field: "request-revision" },
    });
    expect(
      TrackerStep.decide(
        "gate",
        unproven({ approvalId: "approval-1", approval: approval({ state: "revoked" }) }),
      ),
    ).toEqual({ refused: { reason: "approval-revoked", approvalId: "approval-1" } });
    expect(
      TrackerStep.decide("gate", unproven({ approvalId: "approval-1", approval: approval() })),
    ).toEqual({ next: "write" });
  });

  test("write never sends again for a request that already recorded an answer", () => {
    expect(TrackerStep.decide("write", { attempts: [attempt()], requestId: "request-1" })).toEqual({
      next: "report",
    });
    expect(
      TrackerStep.decide("write", {
        attempts: [attempt({ state: "intended" })],
        requestId: "request-1",
      }),
    ).toEqual({ next: "write" });
    expect(TrackerStep.decide("write", { attempts: [attempt()], requestId: "request-2" })).toEqual({
      next: "write",
    });
  });
});
