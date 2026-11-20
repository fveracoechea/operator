import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Err, ErrAsync, Ok, fromPromise, OkAsync } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";
import { WorkerDispatch } from "../worker-dispatch/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { Projects } from "../projects/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { associationBody, failed, git, prDevice, repository, succeeded } from "./device-fixture.ts";
import { dispatch, dispatchPermission, handoff, owned, reviewEnded } from "./internal-review.ts";
import { PullRequests } from "./main.ts";

test("the merge readiness witness is an explicit transition, never an ended or absent review", () => {
  expect(reviewEnded({ readiness: null })).toBe(false);
  expect(
    reviewEnded({
      readiness: JSON.stringify({ head: "pushed", at: "now", note: null, dispositions: [] }),
    }),
  ).toBe(true);
});

afterEach(() => mock.restore());

test("a ready handoff fences its outgoing owner at the PR interface before pane closure", async () => {
  await using device = await prDevice();
  const started = device.start("parent");
  expect(
    DeviceState.associatePullRequest(device.paths, started.launchId, {
      number: 7,
      url: `https://github.com/${repository}/pull/7`,
      branch: "task/parent",
      relay: null,
      readiness: { head: "h", at: "now", note: null, dispositions: [] },
    }).tag,
  ).toBe("Ok");
  const read = DeviceState.worktreeOwners(device.paths);
  expect(read.tag).toBe("Ok");
  if (read.tag !== "Ok") return;
  const owner = read.value[0] ?? expect.unreachable("Missing recorded owner");
  expect(
    await owned({ ...owner, worktreePath: started.worktree, branch: "task/parent" }),
  ).toMatchObject({ tag: "Err", error: { reason: "pr_handed_off" } });
  expect(device.calls).toEqual([]);
});

test.each([1, 2])(
  "effect-time check %s retains the original cause through the PR facade",
  async (check) => {
    await using device = await prDevice();
    const socket = `${device.root}/herdr.sock`;
    const owner = device.start("parent", { socket });
    expect(
      DeviceState.associatePullRequest(
        device.paths,
        owner.launchId,
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
    expect(DeviceState.startHandoff(device.paths, device.sourceId, "parent", process.pid).tag).toBe(
      "Ok",
    );
    spyOn(Environment, "read").mockReturnValue({
      ...Environment.read(),
      HERDR_SOCKET_PATH: socket,
      HERDR_PANE_ID: "p1",
    });
    spyOn(WorkSources, "checkSupervisor").mockReturnValue(OkAsync(undefined));
    spyOn(WorkerDispatch, "checkHandoff").mockReturnValue(OkAsync(undefined));
    const cause = new Error("original continuation fault", { cause: { original: true } });
    const defect = await fromPromise(Promise.reject(cause), (error, unexpected) =>
      unexpected(error),
    );
    const original = DeviceState.checkHandoffContinuation;
    let checks = 0;
    spyOn(DeviceState, "checkHandoffContinuation").mockImplementation((...args) =>
      ++checks === check ? defect : original(...args),
    );
    const failed = spyOn(DeviceState, "failHandoff");
    const closed = spyOn(Herdr, "closePane");
    const launched = spyOn(WorkerDispatch, "dispatch");
    const exited = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
    expect(await exited.exited).toBe(0);
    const result = await PullRequests.dispatch({
      paths: device.paths,
      cwd: device.checkout,
      sourceId: device.sourceId,
      assignment: "parent",
      afterPid: exited.pid,
    });
    expect(result.tag, JSON.stringify(result)).toBe("Defect");
    expect(result.tag === "Defect" ? result.cause : undefined).toBe(cause);
    expect(checks).toBe(check);
    expect(failed).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(launched).not.toHaveBeenCalled();
    expect(DeviceState.readSources(device.paths, repository, device.sourceId)).toMatchObject({
      tag: "Ok",
      value: [
        {
          launches: [{ state: "running" }],
          handoffs: [{ handoffState: "pending", handoffDetail: null }],
        },
      ],
    });
    expect(device.calls).toEqual([]);
  },
);

test.each(["supervisor", "project", "publication"] as const)(
  "dispatch permission preserves the %s Defect cause and authorizes no effects",
  async (stage) => {
    await using device = await prDevice();
    const cause = new Error(`${stage} defect`, { cause: { original: true } });
    const defect = await fromPromise(Promise.reject(cause), (error, unexpected) =>
      unexpected(error),
    );
    const supervisor = spyOn(WorkSources, "checkSupervisor").mockReturnValue(
      stage === "supervisor" ? defect.toAsync() : OkAsync(undefined),
    );
    const project = spyOn(Projects, "current");
    if (stage === "project") project.mockReturnValue(defect.toAsync());
    const publication = spyOn(DeviceState, "readHandoffContinuation").mockReturnValue(defect);
    const claim = spyOn(DeviceState, "claimHandoff");
    const close = spyOn(Herdr, "closePane");
    const launch = spyOn(WorkerDispatch, "dispatch");
    const input = {
      paths: device.paths,
      cwd: device.checkout,
      sourceId: device.sourceId,
      assignment: "parent",
      afterPid: process.ppid,
    };
    for (const result of [await dispatchPermission(input), await dispatch(input)]) {
      expect(result.tag).toBe("Defect");
      expect(result.tag === "Defect" ? result.cause : undefined).toBe(cause);
    }
    expect(supervisor).toHaveBeenCalledTimes(2);
    expect(project).toHaveBeenCalledTimes(stage === "supervisor" ? 0 : 2);
    expect(publication).toHaveBeenCalledTimes(stage === "publication" ? 2 : 0);
    expect(claim).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(device.calls).toEqual([]);
  },
);

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
