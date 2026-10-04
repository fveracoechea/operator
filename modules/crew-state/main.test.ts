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
