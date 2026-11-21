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
import {
  dispatch,
  dispatchPermission,
  handoff,
  owned,
  reviewEnded,
  round,
} from "./internal-review.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { PullRequests } from "./main.ts";

test("the merge readiness witness is an explicit transition, never an ended or absent review", () => {
  expect(reviewEnded({ readiness: null })).toBe(false);
  expect(
    reviewEnded({
      readiness: { head: "pushed", at: "now", note: null, dispositions: [] },
    }),
  ).toBe(true);
});

afterEach(() => mock.restore());

test.each(["review", "implementation"])(
  "round and ownership adapters allow a direct %s reviewer only",
  async (kind) => {
    await using device = await prDevice();
    const started = device.start("parent", { kind: JSON.stringify(WorkerKinds.resolve(kind)) });
    const pr = {
      number: 7,
      url: `https://github.com/${repository}/pull/7`,
      branch: "task/parent",
      relay: null,
    };
    expect(
      (kind === "review"
        ? DeviceState.adoptPullRequest(device.paths, started.launchId, pr, {
            internalReview: true,
            assignmentReview: false,
          })
        : DeviceState.associatePullRequest(device.paths, started.launchId, pr, false, true)
      ).tag,
    ).toBe("Ok");
    const file = `${device.root}/findings.md`;
    await Bun.write(file, "## Findings\n- nice-to-have, Spec, src/api.ts: Keep the API.\n");
    const before = await Bun.file(device.paths.database).arrayBuffer();
    const result = await round({ paths: device.paths, cwd: started.worktree, file });
    const owners = DeviceState.worktreeOwners(device.paths);
    expect(owners.tag).toBe("Ok");
    if (owners.tag !== "Ok") return;
    const owner = owners.value[0] ?? expect.unreachable("Missing owner");
    const ownership = await owned({
      ...owner,
      worktreePath: started.worktree,
      branch: "task/parent",
    });
    if (kind === "review") {
      expect(result).toMatchObject({
        tag: "Ok",
        value: {
          reason: "pr_round_recorded",
          data: { round: 1, head: git(started.worktree, "rev-parse", "HEAD"), findings: 1 },
        },
      });
      expect(ownership).toMatchObject({ tag: "Ok", value: { launchId: started.launchId } });
      expect(DeviceState.readSources(device.paths, repository, device.sourceId)).toMatchObject({
        tag: "Ok",
        value: [
          {
            internalReviewRounds: [
              {
                number: 1,
                findings: JSON.stringify([
                  {
                    axis: "Spec",
                    severity: "nice-to-have",
                    location: "src/api.ts",
                    claim: "Keep the API.",
                  },
                ]),
              },
            ],
          },
        ],
      });
    } else {
      expect(result).toMatchObject({ tag: "Err", error: { reason: "pr_handed_off" } });
      expect(ownership).toMatchObject({ tag: "Err", error: { reason: "pr_handed_off" } });
      expect(await Bun.file(device.paths.database).arrayBuffer()).toEqual(before);
    }
    expect(device.calls).toEqual([]);
  },
);

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

test.each([1, 2, "finish", "dispatch", "reservation"] as const)(
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
    const publication = DeviceState.readHandoffContinuation;
    let publicationReads = 0;
    spyOn(DeviceState, "readHandoffContinuation").mockImplementation((...args) => {
      publicationReads++;
      if (publicationReads === 1) return publication(...args);
      return Err({
        reason: "handoff_continuation_refused" as const,
        detail: "The already published receipt must not be polled again before its effect checks.",
        next: { command: "operator next", why: "Recover the stopped handoff." },
      });
    });
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
    const closed = spyOn(Herdr, "closePane").mockReturnValue(OkAsync("closed" as const));
    const finished = spyOn(DeviceState, "finishImplementer");
    if (check === "finish") finished.mockReturnValue(defect);
    const launched = spyOn(WorkerDispatch, "dispatch").mockImplementation((request) => {
      expect(request).toMatchObject({
        paths: device.paths,
        cwd: device.checkout,
        sourceId: device.sourceId,
        assignment: "parent",
        handoff: true,
        continuation: {
          repository,
          sourceId: device.sourceId,
          assignment: "parent",
          outgoingLaunchId: owner.launchId,
          nextKind: "review",
          pane: "p1",
          socket,
        },
      });
      return defect.toAsync();
    });
    let expectedCause: unknown = cause;
    if (check === "reservation")
      launched.mockImplementation((request) => {
        const read = DeviceState.readSources(device.paths, repository, device.sourceId);
        const outgoing = read.tag === "Ok" ? read.value[0]?.launches[0] : undefined;
        if (outgoing === undefined) return expect.unreachable("The outgoing launch exists.");
        const reserved = DeviceState.reserveLaunch(
          request.paths,
          device.checkout,
          repository,
          { ...outgoing, id: "reviewer", name: "reviewer", kind: "{" },
          undefined,
          { pane: "worker", session: "ses_worker" },
          request.continuation,
        );
        expect(reserved.tag).toBe("Defect");
        expectedCause = reserved.tag === "Defect" ? reserved.cause : undefined;
        return reserved
          .map(() => expect.unreachable("The malformed snapshot cannot reserve."))
          .toAsync();
      });
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
    expect(result.tag === "Defect" ? result.cause : undefined).toBe(expectedCause);
    expect(publicationReads).toBe(1);
    expect(checks).toBe(check === 1 ? 1 : 2);
    expect(failed).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(check === 1 || check === 2 ? 0 : 1);
    expect(finished).toHaveBeenCalledTimes(check === 1 || check === 2 ? 0 : 1);
    expect(launched).toHaveBeenCalledTimes(check === "dispatch" || check === "reservation" ? 1 : 0);
    expect(DeviceState.readSources(device.paths, repository, device.sourceId)).toMatchObject({
      tag: "Ok",
      value: [
        {
          launches: [
            { state: check === "dispatch" || check === "reservation" ? "finished" : "running" },
          ],
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

test("an ordinary handoff dispatch defect retains its cause and does not record an operational failure", async () => {
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
  const cause = new Error("dispatch defect");
  const dispatch = spyOn(WorkerDispatch, "dispatch").mockReturnValue(
    fromPromise(Promise.reject(cause), (cause, defect) => defect(cause)),
  );
  const failed = spyOn(DeviceState, "failHandoff");
  const result = await handoff({
    paths: device.paths,
    cwd: device.checkout,
    sourceId: device.sourceId,
    assignment: "parent",
    afterPid: null,
  });
  expect(result.tag).toBe("Defect");
  expect(result.tag === "Defect" ? result.cause : undefined).toBe(cause);
  expect(failed).not.toHaveBeenCalled();
  expect(close.mock.calls).toEqual([["p1"]]);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(DeviceState.readSources(device.paths, repository, device.sourceId)).toMatchObject({
    tag: "Ok",
    value: [
      {
        launches: [{ state: "finished", paneId: "p1" }],
        internalReviews: [{ handoffState: "pending" }],
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
          "The recorded recovery does not authorize this handoff. No implementer pane was closed and no successor was started. Handoff progress was claimed before this refusal.",
      },
    });
  if (change === "dirty")
    expect(result).toMatchObject({ error: { reason: "pr_worktree_unclean" } });
  if (change === "draft") expect(result).toMatchObject({ error: { reason: "pr_draft_required" } });
  if (change === "local-head")
    expect(result).toMatchObject({ error: { reason: "pr_worktree_unsynced" } });
  if (change !== "audit-read")
    expect(confirm).toHaveBeenCalledWith(device.paths, { ...receipt, launchId: owner.launchId });
  else
    expect(result).toMatchObject({
      tag: "Err",
      error: {
        reason: "state_missing",
        detail: "missing",
        next: { command: "operator next", why: "Inspect." },
      },
    });
});

test("a corrupt recovery refusal reports its prior claim without asserting that nothing changed", async () => {
  await using device = await prDevice();
  const owner = device.start("parent");
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
  spyOn(DeviceState, "readInternalReviewRecovery").mockReturnValue(
    Err({
      reason: "internal_review_recovery_incompatible",
      detail:
        "The recorded assignment does not match the promoted internal review recovery. Nothing was changed.",
      next: {
        command: "operator next",
        why: "Read the assignment's current state before choosing another action.",
      },
    }),
  );
  const confirm = spyOn(DeviceState, "recoverInternalReview");
  const close = spyOn(Herdr, "closePane");
  const launch = spyOn(WorkerDispatch, "dispatch");
  const result = await handoff({
    paths: device.paths,
    cwd: device.checkout,
    sourceId: device.sourceId,
    assignment: "parent",
    afterPid: null,
  });
  expect(result).toMatchObject({
    tag: "Err",
    error: {
      reason: "internal_review_recovery_incompatible",
      detail:
        "The recorded recovery does not authorize this handoff. No implementer pane was closed and no successor was started. Handoff progress was claimed before this refusal.",
      next: {
        command: "operator next",
        why: "Read the assignment's current state before choosing another action.",
      },
      state: { handoffClaimed: true },
    },
  });
  expect(confirm).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
  expect(DeviceState.readSources(device.paths, repository, device.sourceId)).toMatchObject({
    tag: "Ok",
    value: [
      {
        launches: [{ state: "running" }],
        handoffs: [
          {
            handoffState: "failed",
            handoffDetail:
              "internal_review_recovery_incompatible: The recorded recovery does not authorize this handoff. No implementer pane was closed and no successor was started. Handoff progress was claimed before this refusal.",
          },
        ],
      },
    ],
  });
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
