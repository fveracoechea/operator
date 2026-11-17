import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Err, ErrAsync, Ok, fromPromise, OkAsync } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";
import { WorkerDispatch } from "../worker-dispatch/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { associationBody, failed, git, prDevice, repository, succeeded } from "./device-fixture.ts";
import { handoff } from "./internal-review.ts";

afterEach(() => mock.restore());

async function changeRecoveryWorktree(
  change: string,
  device: Awaited<ReturnType<typeof prDevice>>,
  owner: ReturnType<Awaited<ReturnType<typeof prDevice>>["start"]>,
) {
  if (change === "owner" || change === "finished-branch")
    expect(DeviceState.finishImplementer(device.paths, owner.launchId).tag).toBe("Ok");
  if (change === "branch" || change === "finished-branch")
    git(owner.worktree, "checkout", "--detach");
  if (change === "ambiguous-owner")
    device.start("other", { worktree: owner.worktree, branch: "task/parent", add: false });
  if (change === "dirty") await Bun.write(`${owner.worktree}/unlanded`, "keep me");
  if (change === "local-head")
    git(owner.worktree, "commit", "--allow-empty", "-m", "new local head");
}

test("a dispatch defect during handoff keeps the recorded recovery instead of losing its cause", async () => {
  await using device = await prDevice();
  const socket = `${device.root}/herdr.sock`;
  const started = device.start("parent", { socket });
  expect(
    DeviceState.associatePullRequest(
      device.paths,
      started.launchId,
      {
        number: 7,
        url: `https://github.com/${repository}/pull/7`,
        branch: "task/parent",
        relay: null,
      },
      false,
      true,
    ).tag,
  ).toBe("Ok");
  spyOn(Environment, "read").mockReturnValue({ ...Environment.read(), HERDR_SOCKET_PATH: socket });
  const close = spyOn(Herdr, "closePane").mockReturnValue(OkAsync("closed" as const));
  const dispatch = spyOn(WorkerDispatch, "dispatch").mockReturnValue(
    fromPromise(Promise.reject(new Error("dispatch defect")), (cause, defect) => defect(cause)),
  );
  expect(
    await handoff({
      paths: device.paths,
      cwd: device.checkout,
      sourceId: device.sourceId,
      assignment: "parent",
      afterPid: null,
    }),
  ).toMatchObject({
    tag: "Err",
    error: {
      reason: "handoff_defect",
      detail: "Error: dispatch defect",
      next: {
        decider: "super-agent",
        question:
          "How should the failed internal-review handoff be recovered from its recorded progress?",
      },
    },
  });
  expect(close.mock.calls).toEqual([["p1"]]);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(DeviceState.readSources(device.paths, repository, device.sourceId)).toMatchObject({
    tag: "Ok",
    value: [
      {
        launches: [{ state: "finished", paneId: "p1" }],
        internalReviews: [{ handoffState: "failed" }],
      },
    ],
  });
  expect(device.calls).toEqual([]);
});

test.each([
  "valid",
  "audit-read",
  "confirm",
  "owner",
  "github",
  "missing",
  "ambiguous",
  "number",
  "url",
  "head",
  "branch",
  "draft",
  "dirty",
  "local-head",
  "tree",
  "ambiguous-owner",
  "finished-branch",
])("a recovered handoff revalidates %s before closing its implementer", async (change) => {
  await using device = await prDevice({ assignments: ["parent", "other"] });
  const socket = `${device.root}/herdr.sock`;
  const owner = device.start("parent", { socket });
  expect(
    DeviceState.associatePullRequest(
      device.paths,
      owner.launchId,
      {
        number: 415,
        url: `https://github.com/${repository}/pull/415`,
        branch: "task/parent",
        relay: null,
      },
      false,
      true,
    ).tag,
  ).toBe("Ok");
  const head = git(owner.worktree, "rev-parse", "HEAD");
  const receipt = {
    sourceId: device.sourceId,
    assignment: "parent",
    repository,
    implementerLaunchId: owner.launchId,
    number: 415,
    url: `https://github.com/${repository}/pull/415`,
    branch: "task/parent",
    worktreePath: owner.worktree,
    head,
    personInstructed: true,
    authorizedAt: "2026-11-16T00:00:00.000Z",
  };
  const audit = spyOn(DeviceState, "readInternalReviewRecovery").mockReturnValue(Ok(receipt));
  const confirm = spyOn(DeviceState, "recoverInternalReview").mockReturnValue(
    Ok({ changed: false }),
  );
  spyOn(Environment, "read").mockReturnValue({ ...Environment.read(), HERDR_SOCKET_PATH: socket });
  const close = spyOn(Herdr, "closePane").mockReturnValue(OkAsync("closed" as const));
  const dispatch = spyOn(WorkerDispatch, "dispatch").mockReturnValue(
    ErrAsync({
      reason: "launch_failed",
      detail: "controlled stop",
      next: { command: "operator next", why: "Inspect launch." },
    }),
  );
  const body = associationBody([{ number: 415, base: "main", head: "task/parent" }]);
  body.data.repository.pullRequests.nodes = body.data.repository.pullRequests.nodes.map((node) => ({
    ...node,
    isDraft: change !== "draft",
    headRefOid: change === "head" ? "b".repeat(40) : head,
    number: change === "number" ? 416 : 415,
    url: change === "url" ? "other" : receipt.url,
  }));
  if (change === "missing") body.data.repository.pullRequests.nodes = [];
  if (change === "ambiguous")
    body.data.repository.pullRequests.nodes.push(...body.data.repository.pullRequests.nodes);
  device.answer(() => (change === "github" ? failed("offline") : succeeded(body)));
  if (change === "audit-read")
    audit.mockReturnValue(
      Err({
        reason: "state_missing",
        detail: "missing",
        next: { command: "operator next", why: "Inspect." },
      }),
    );
  if (change === "confirm")
    confirm.mockReturnValue(
      Err({
        reason: "internal_review_recovery_incompatible",
        detail: "ended",
        next: { command: "operator next", why: "Inspect." },
      }),
    );
  await changeRecoveryWorktree(change, device, owner);
  if (change === "tree") {
    const run = ToolInvocation.run;
    spyOn(ToolInvocation, "run").mockImplementation((request) =>
      request.args.includes("status")
        ? Promise.reject(Object.assign(new Error("unreadable"), { code: "EIO" }))
        : run(request),
    );
  }
  const result = await handoff({
    paths: device.paths,
    cwd: device.checkout,
    sourceId: device.sourceId,
    assignment: "parent",
    afterPid: null,
  });
  expect(result.tag).toBe("Err");
  if (change === "valid") {
    expect(close).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  } else if (change === "owner") {
    expect(close).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  } else {
    expect(close).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  }
  if (["missing", "ambiguous", "number", "url", "head"].includes(change))
    expect(result).toMatchObject({
      error: {
        reason: "internal_review_recovery_incompatible",
        detail:
          "The recovered handoff no longer matches its authorized PR, branch, and head. Nothing was handed off.",
      },
    });
  if (change === "dirty")
    expect(result).toMatchObject({ error: { reason: "pr_worktree_unclean" } });
  if (change === "draft") expect(result).toMatchObject({ error: { reason: "pr_draft_required" } });
  if (change === "local-head")
    expect(result).toMatchObject({ error: { reason: "pr_worktree_unsynced" } });
  if (change !== "audit-read")
    expect(confirm).toHaveBeenCalledWith(device.paths, { ...receipt, launchId: owner.launchId });
});

test.each(["mismatch", "defect"] as const)(
  "a handoff %s keeps its owner recovery and starts no reviewer",
  async (kind) => {
    await using device = await prDevice();
    const socket = `${device.root}/herdr.sock`;
    const started = device.start("parent", { socket });
    expect(
      DeviceState.associatePullRequest(
        device.paths,
        started.launchId,
        {
          number: 7,
          url: `https://github.com/${repository}/pull/7`,
          branch: "task/parent",
          relay: null,
        },
        false,
        true,
      ).tag,
    ).toBe("Ok");
    const environment = Environment.read();
    spyOn(Environment, "read").mockReturnValue({
      ...environment,
      HERDR_SOCKET_PATH: kind === "mismatch" ? "/other-session" : socket,
    });
    const close = spyOn(Herdr, "closePane").mockReturnValue(
      fromPromise(Promise.reject(new Error("injected")), (cause, defect) => defect(cause)),
    );
    const dispatch = spyOn(WorkerDispatch, "dispatch");
    const result = await handoff({
      paths: device.paths,
      cwd: device.checkout,
      sourceId: device.sourceId,
      assignment: "parent",
      afterPid: null,
    });
    if (kind === "mismatch") {
      expect(result).toMatchObject({
        tag: "Err",
        error: {
          reason: "herdr_session_mismatch",
          detail:
            "Run operator dispatch in a pane of the Herdr session that started the outgoing worker.",
          next: {
            decider: "super-agent",
            question: "Which pane of the recorded Herdr session should retry this handoff?",
          },
          state: { expectedSocket: socket, actualSocket: "/other-session" },
        },
      });
      expect(close).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject({
        tag: "Err",
        error: {
          reason: "handoff_defect",
          detail: "Error: injected",
          next: {
            decider: "super-agent",
            question:
              "How should the failed internal-review handoff be recovered from its recorded progress?",
          },
        },
      });
      expect(close.mock.calls).toEqual([["p1"]]);
      expect(result.tag === "Err" ? result.error.state : "unexpected").toBeUndefined();
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(device.calls).toEqual([]);
    expect(DeviceState.readSources(device.paths, repository, device.sourceId)).toMatchObject({
      tag: "Ok",
      value: [
        {
          launches: [{ state: "running", paneId: "p1" }],
          internalReviews: [{ handoffState: "failed" }],
        },
      ],
    });
  },
);
