import { afterEach, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { CrewState } from "./main.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** A new crew state, owned, with the token every mutation names. */
async function ownedState(): Promise<{ projectRoot: string; ownerToken: string }> {
  const projectRoot = `${Bun.env.TMPDIR ?? "/tmp"}/operator-crew-state-${crypto.randomUUID()}`;
  roots.push(projectRoot);
  await Bun.$`mkdir -p ${projectRoot}`.quiet();
  const { result } = await CrewState.own({
    projectRoot,
    requestId: crypto.randomUUID(),
    ownerLabel: "test",
    takeover: false,
    ownershipRevision: null,
  });
  if (result.status !== "acquired") {
    throw new Error(`the crew state could not be owned: ${result.status}`);
  }
  return { projectRoot, ownerToken: result.ownership.token };
}

const action = {
  action: "publish",
  targets: ["main"],
  scope: "source-1",
  requestRevision: "revision-1",
};

test("the approval machine: a grant covers its action until a person revokes it once", async () => {
  const crew = await ownedState();
  const granted = await CrewState.grantApproval({
    ...crew,
    requestId: crypto.randomUUID(),
    input: { ...action, exactText: "Yes.", grantedBy: "human" },
  });
  if (granted.result.status !== "granted") {
    throw new Error(`the approval was not granted: ${granted.result.status}`);
  }
  const { approvalId } = granted.result.approval;
  expect(granted.result.approval).toMatchObject({ state: "granted", revision: 1 });
  expect((await CrewState.checkApproval({ ...crew, input: action })).result.status).toBe("matched");

  const revoke = (revision: number, id = approvalId) =>
    CrewState.revokeApproval({
      ...crew,
      requestId: crypto.randomUUID(),
      approvalId: id,
      revision,
    });
  expect((await revoke(1, "no-such-approval")).result).toEqual({
    status: "unknown-approval",
    approvalId: "no-such-approval",
  });
  expect((await revoke(2)).result).toEqual({
    status: "stale-revision",
    approvalId,
    recordedRevision: 1,
  });
  expect((await revoke(1)).result).toMatchObject({
    status: "revoked",
    approval: { state: "revoked", revision: 2 },
  });
  // A revoked approval is refused before its revision is read.
  expect((await revoke(1)).result).toMatchObject({
    status: "already-revoked",
    approval: { state: "revoked", revision: 2 },
  });
  expect((await CrewState.checkApproval({ ...crew, input: action })).result.status).toBe("revoked");
});

test("the next verdict: an owed action outranks a wait, and a standing precondition is never owed", () => {
  const proveReadiness = { action: "prove_readiness", blocker: "readiness_blocked" };
  const run = { action: "run_gate", blocker: null };
  const approve = { action: "publish_stack", blocker: "approval_required" };
  const wait = { wait: "operative_working" };
  const verdict = (actions: { action: string; blocker: string | null }[], waits: unknown[]) =>
    CrewState.verdict({ actions, waits });

  expect(verdict([proveReadiness, approve, run], [wait])).toEqual({
    outcome: "completed",
    reason: "next_actions_reported",
    owed: true,
  });
  expect(verdict([proveReadiness, approve], [wait])).toEqual({
    outcome: "missing-condition",
    reason: "next_actions_blocked",
    owed: true,
  });
  expect(verdict([proveReadiness], [wait])).toEqual({
    outcome: "pending",
    reason: "next_actions_waiting",
    owed: false,
  });
  expect(verdict([proveReadiness], [])).toEqual({
    outcome: "missing-condition",
    reason: "next_actions_blocked",
    owed: false,
  });
  expect(verdict([], [])).toEqual({
    outcome: "completed",
    reason: "next_actions_none",
    owed: false,
  });
});

test("the next report gives its verdict and names the blocker of each blocked action", async () => {
  const { projectRoot } = await ownedState();
  const { result } = await CrewState.next({
    projectRoot,
    readiness: { ready: false, detail: "Readiness is blocked: git." },
  });
  if (result.status !== "reported") throw new Error(`crew next did not report: ${result.status}`);

  expect(result.verdict).toEqual({
    outcome: "missing-condition",
    reason: "next_actions_blocked",
    owed: false,
  });
  expect(result.blockers).toEqual([
    {
      reason: "readiness_blocked",
      action: "prove_readiness",
      assignmentId: null,
      attemptId: null,
      questionId: null,
      reviewId: null,
      detail: "Readiness is blocked: git.",
    },
  ]);
});
