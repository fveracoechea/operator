import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Err, Ok } from "unthrown";
import { Database } from "bun:sqlite";
import { DeviceState } from "../device-state/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { Environment } from "../environment/main.ts";
import {
  failed,
  git,
  mergeRequest,
  prDevice,
  pullRequestBody,
  repository,
  requestKind,
  succeeded,
  uncertain,
} from "./device-fixture.ts";
import { merge } from "./merge.ts";
import { stacked } from "./relay.ts";

afterEach(() => {
  mock.restore();
});

const cli = Bun.fileURLToPath(new URL("../../cli.ts", import.meta.url));
const parent = { assignment: "parent", number: 6, branch: "task/parent" };
const passingConditions = {
  approved: true,
  checksPassing: true,
  threadsResolved: true,
  defaultBase: true,
  notDraft: true,
  stackRelayed: true,
  reviewEnded: true,
};
const effectRecovery = {
  decider: "super-agent",
  question:
    "How should GitHub's current state be inspected before repeating the unconfirmed request?",
};
const refusedRecovery = {
  decider: "person",
  question: "Which GitHub merge restriction must be resolved before this PR can merge?",
};
const verifyRecovery = {
  command: "operator pr merge",
  why: "Verify whether the earlier merge request landed.",
};

/** A running owner of `other` with PR #7 recorded, and a cleanup start that never runs. */
async function owner(relay: string | null = null, assignments?: string[]) {
  const device = await prDevice({ assignments });
  const started = device.start("other");
  device.associate(started.launchId, 7, "task/other", relay);
  const head = git(started.worktree, "rev-parse", "HEAD");
  // A live process that is not this one, so the recorded cleanup stays visibly running.
  const detach = spyOn(ToolInvocation, "detach").mockReturnValue(process.ppid);
  // A background merge request is read once each second, which the units skip.
  const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
  return {
    device,
    ...started,
    head,
    detach,
    sleep,
    input: { paths: device.paths, cwd: started.worktree },
  };
}

function assignmentState(device: Awaited<ReturnType<typeof prDevice>>) {
  const owners = DeviceState.worktreeOwners(device.paths);
  return owners.tag === "Ok"
    ? owners.value.find((row) => row.assignment === "other")?.assignmentState
    : null;
}

function cleanupClaim(device: Awaited<ReturnType<typeof prDevice>>) {
  return DeviceState.claimCleanup(device.paths, repository, device.sourceId, "other");
}

function merged(head: string, mergeCommit = "m1") {
  return {
    sourceId: expect.any(String) as unknown,
    assignment: "other",
    branch: "task/other",
    number: 7,
    head,
    mergeCommit,
    state: "merged",
    cleanup: "started",
  };
}

test("an eligible PR at the worktree head merges once and starts its cleanup", async () => {
  const { device, head, detach, sleep, input } = await owner();
  await using _ = device;
  let landed = false;
  device.answer((args) => {
    const kind = requestKind(args);
    if (kind === "merge") return mergeRequest("pending", "u1");
    if (kind === "merge_read") {
      landed = true;
      return mergeRequest("merged");
    }
    return succeeded(
      pullRequestBody(landed ? { state: "MERGED", head, mergeCommit: "m1" } : { head }),
    );
  });
  expect<unknown>(await merge(input)).toEqual({
    tag: "Ok",
    value: { reason: "pr_merged", data: { ...merged(head), sourceId: device.sourceId } },
  });
  expect(device.calls.map(requestKind)).toEqual([
    "pull_request",
    "merge",
    "merge_read",
    "pull_request",
  ]);
  expect(device.calls[1]).toEqual([
    "-X",
    "PUT",
    `repos/${repository}/pulls/7/merge-async`,
    "-f",
    `sha=${head}`,
    "-f",
    "merge_method=squash",
    "-f",
    "merge_action=direct_merge",
  ]);
  expect(device.calls[2]).toEqual([`repos/${repository}/pulls/7/merge-async/u1`]);
  expect(sleep.mock.calls).toEqual([[1000]]);
  expect(detach.mock.calls).toEqual([
    [
      {
        tool: process.execPath,
        args: [cli, "cleanup", "--source", device.sourceId, "--assignment", "other", "--json"],
        cwd: device.checkout,
      },
    ],
  ]);
  expect(assignmentState(device)).toBe("merged");
  expect<unknown>(cleanupClaim(device)).toMatchObject({
    tag: "Err",
    error: {
      reason: "cleanup_running",
      detail: expect.stringContaining(`${process.ppid}`) as unknown,
    },
  });
});

test("dirty work refuses delivery without a merge request or cleanup", async () => {
  const { device, head, input, detach } = await owner();
  await using _ = device;
  await Bun.write(`${input.cwd}/uncommitted.txt`, "keep this work\n");
  device.answer(() => succeeded(pullRequestBody({ head })));
  const claim = spyOn(DeviceState, "claimDelivery");
  expect<unknown>(await merge(input)).toMatchObject({
    tag: "Err",
    error: {
      reason: "pr_worktree_unclean",
      detail:
        "Commit and push changed and untracked work before delivery. Nothing was merged or removed.",
      next: {
        command: "operator pr wait --json",
        why: "The owner must commit and push its changes before delivery.",
      },
    },
  });
  expect(device.calls.filter((args) => requestKind(args) === "merge")).toHaveLength(0);
  expect(detach).not.toHaveBeenCalled();
  expect(claim).not.toHaveBeenCalled();
  expect(await Bun.file(`${input.cwd}/uncommitted.txt`).text()).toBe("keep this work\n");
});

test("a lost request remains durable and an OPEN PR never authorizes another mutation", async () => {
  const { device, head, input, launchId } = await owner();
  await using _ = device;
  device.answer((args) =>
    requestKind(args) === "merge"
      ? uncertain("lost response")
      : succeeded(pullRequestBody({ head })),
  );
  expect<unknown>(await merge(input)).toMatchObject({
    tag: "Err",
    error: { reason: "github_uncertain" },
  });
  expect<unknown>(DeviceState.readDelivery(device.paths, launchId)).toMatchObject({
    tag: "Ok",
    value: { head, endedAt: null, ownerPid: null },
  });
  expect<unknown>(await merge(input)).toMatchObject({
    tag: "Err",
    error: {
      reason: "pr_delivery_running",
      detail:
        "The earlier delivery has an unknown outcome and no request identity. An OPEN PR does not prove it stopped. No new merge was requested.",
      next: {
        decider: "super-agent",
        question:
          "How can the earlier delivery's terminal outcome be established without submitting another merge?",
      },
    },
  });
  expect(device.calls.filter((args) => requestKind(args) === "merge")).toHaveLength(1);
  device.answer(() =>
    succeeded(pullRequestBody({ state: "MERGED", head, mergeCommit: "eventual" })),
  );
  expect<unknown>(await merge(input)).toMatchObject({ tag: "Ok", value: { reason: "pr_merged" } });
  expect<unknown>(DeviceState.readDelivery(device.paths, launchId)).toMatchObject({
    tag: "Ok",
    value: null,
  });
  expect(device.calls.filter((args) => requestKind(args) === "merge")).toHaveLength(1);
});

test("queued requests recover their UUID, settle a proven failure, then permit a fresh guarded attempt", async () => {
  const { device, head, input, launchId } = await owner();
  await using _ = device;
  device.answer((args) =>
    requestKind(args) === "merge"
      ? mergeRequest("enqueued", "queued-id")
      : succeeded(pullRequestBody({ head })),
  );
  expect<unknown>(await merge(input)).toMatchObject({
    tag: "Err",
    error: { reason: "pr_merge_unverified" },
  });
  expect<unknown>(DeviceState.readDelivery(device.paths, launchId)).toMatchObject({
    tag: "Ok",
    value: { requestUuid: "queued-id", endedAt: null },
  });
  device.calls.length = 0;
  device.answer((args) =>
    requestKind(args) === "merge_read"
      ? mergeRequest("failed")
      : succeeded(pullRequestBody({ head })),
  );
  expect<unknown>(await merge(input)).toMatchObject({
    tag: "Err",
    error: { reason: "pr_merge_refused" },
  });
  expect(device.calls.map(requestKind)).toEqual(["pull_request", "merge_read", "pull_request"]);
  expect(device.calls[1]).toEqual([`repos/${repository}/pulls/7/merge-async/queued-id`]);
  expect<unknown>(DeviceState.readDelivery(device.paths, launchId)).toMatchObject({
    tag: "Ok",
    value: null,
  });
  device.answer((args) =>
    requestKind(args) === "merge"
      ? failed("Head branch was modified")
      : succeeded(pullRequestBody({ head })),
  );
  expect<unknown>(await merge(input)).toMatchObject({
    tag: "Err",
    error: { reason: "pr_merge_refused" },
  });
  expect(device.calls.filter((args) => requestKind(args) === "merge")).toHaveLength(1);
  expect<unknown>(DeviceState.readDelivery(device.paths, launchId)).toMatchObject({
    tag: "Ok",
    value: null,
  });
});

test("a stopped first request read retains the claim, while a queued read retains the original UUID", async () => {
  const { device, head, input, launchId } = await owner();
  await using _ = device;
  const stop = mock(() => {});
  spyOn(DeviceState, "holdDelivery").mockReturnValue(stop);
  device.answer((args) => {
    const kind = requestKind(args);
    if (kind === "merge") return mergeRequest("pending", "original-id");
    if (kind === "merge_read") return failed("Not Found", 404);
    return succeeded(pullRequestBody({ head }));
  });
  expect<unknown>(await merge(input)).toMatchObject({
    tag: "Err",
    error: {
      reason: "pr_merge_unverified",
      detail:
        "GitHub did not answer the merge request read: github_refused: Not Found. Nothing was recorded. Repeat operator pr merge.",
    },
  });
  expect(stop).toHaveBeenCalledTimes(1);
  expect<unknown>(DeviceState.readDelivery(device.paths, launchId)).toMatchObject({
    tag: "Ok",
    value: { requestUuid: "original-id", endedAt: null },
  });
  device.answer((args) =>
    requestKind(args) === "merge_read"
      ? mergeRequest("enqueued")
      : succeeded(pullRequestBody({ head })),
  );
  expect<unknown>(await merge(input)).toMatchObject({
    tag: "Err",
    error: { reason: "pr_merge_unverified" },
  });
  expect<unknown>(DeviceState.readDelivery(device.paths, launchId)).toMatchObject({
    tag: "Ok",
    value: { requestUuid: "original-id", endedAt: null },
  });
  expect(device.calls.filter((args) => requestKind(args) === "merge")).toHaveLength(1);
});

test("a current head different from the ready head cannot use observational reconciliation to submit a merge", async () => {
  const { device, head, input, launchId } = await owner();
  await using _ = device;
  expect(
    DeviceState.observePane(device.paths, {
      socket: `${device.root}/herdr.sock`,
      workspaceId: null,
      paneId: "p1",
      observation: { exited: true },
    }).tag,
  ).toBe("Ok");
  device.start("other", { worktree: input.cwd, branch: "task/other", add: false });
  using db = new Database(device.paths.database);
  db.query(
    "INSERT INTO internal_reviews (source_id, assignment, state, ready_head, implementer_launch_id, handoff_state, started_at, updated_at) VALUES (?, 'other', 'ready', 'original-ready', ?, 'ended', 'then', 'now')",
  ).run(device.sourceId, launchId);
  device.answer(() => succeeded(pullRequestBody({ head })));
  expect<unknown>(await merge(input)).toMatchObject({
    tag: "Err",
    error: { reason: "pr_validation_stale" },
  });
  expect(device.calls.filter((args) => requestKind(args) === "merge")).toHaveLength(0);
  device.answer(() =>
    succeeded(pullRequestBody({ state: "MERGED", head, mergeCommit: "external" })),
  );
  expect<unknown>(await merge(input)).toMatchObject({ tag: "Ok", value: { reason: "pr_merged" } });
});

test("a replacement owner finds and reconciles the original launch's outstanding delivery without resubmitting", async () => {
  const { device, head, input, launchId } = await owner();
  await using _ = device;
  spyOn(Environment, "caller").mockReturnValue({ pane: null, session: "original-worker" });
  device.answer((args) =>
    requestKind(args) === "merge" ? uncertain("lost") : succeeded(pullRequestBody({ head })),
  );
  expect((await merge(input)).tag).toBe("Err");
  expect(
    DeviceState.observePane(device.paths, {
      socket: `${device.root}/herdr.sock`,
      workspaceId: null,
      paneId: "p1",
      observation: { exited: true },
    }).tag,
  ).toBe("Ok");
  const replacement = device.start("other", {
    worktree: input.cwd,
    branch: "task/other",
    add: false,
  });
  expect<unknown>(DeviceState.readDelivery(device.paths, replacement.launchId)).toMatchObject({
    tag: "Ok",
    value: { launchId, head, session: "original-worker", endedAt: null },
  });
  spyOn(Environment, "caller").mockReturnValue({ pane: null, session: "replacement-worker" });
  expect<unknown>(await merge(input)).toMatchObject({
    tag: "Err",
    error: { reason: "pr_delivery_running" },
  });
  device.answer(() =>
    succeeded(pullRequestBody({ state: "MERGED", head, mergeCommit: "eventual" })),
  );
  expect<unknown>(await merge(input)).toMatchObject({ tag: "Ok", value: { reason: "pr_merged" } });
  expect(device.calls.filter((args) => requestKind(args) === "merge")).toHaveLength(1);
  using db = new Database(device.paths.database);
  expect(
    db
      .query("SELECT launch_id, head, session, ended_at IS NOT NULL AS ended FROM deliveries")
      .all(),
  ).toEqual([{ launch_id: launchId, head, session: "original-worker", ended: 1 }]);
});

test("a delivery settled between observation and reconciliation cannot create a new uncertainty claim", async () => {
  const { device, head, input, launchId } = await owner();
  await using _ = device;
  device.answer((args) =>
    requestKind(args) === "merge" ? uncertain("lost") : succeeded(pullRequestBody({ head })),
  );
  expect((await merge(input)).tag).toBe("Err");
  const claim = DeviceState.claimDelivery;
  spyOn(DeviceState, "claimDelivery").mockImplementation((paths, request) => {
    expect(claim(paths, { ...request, resumeId: undefined }).tag).toBe("Ok");
    expect(DeviceState.finishDelivery(paths, launchId, head).tag).toBe("Ok");
    return claim(paths, request);
  });
  expect<unknown>(await merge(input)).toMatchObject({
    tag: "Err",
    error: { reason: "pr_delivery_running" },
  });
  expect<unknown>(DeviceState.readDelivery(device.paths, launchId)).toMatchObject({
    tag: "Ok",
    value: null,
  });
  using db = new Database(device.paths.database);
  expect(db.query("SELECT COUNT(*) AS count FROM deliveries").get()).toEqual({ count: 1 });
  expect(device.calls.filter((args) => requestKind(args) === "merge")).toHaveLength(1);
});

test.each(["identity", "failed", "refused", "prewrite"] as const)(
  "%s persistence failure leaves delivery outstanding rather than permitting a retry",
  async (stage) => {
    const { device, head, input, launchId } = await owner();
    await using _ = device;
    if (stage === "identity")
      spyOn(DeviceState, "recordDeliveryRequest").mockReturnValue(
        Err({
          reason: "state_busy",
          detail: "busy",
          next: {
            decider: "super-agent",
            question: "How should the busy state writer be recovered?",
          },
        }),
      );
    else
      spyOn(DeviceState, "finishDelivery").mockReturnValue(
        Err({
          reason: "state_busy",
          detail: "busy",
          next: {
            decider: "super-agent",
            question: "How should the busy state writer be recovered?",
          },
        }),
      );
    if (stage === "prewrite") {
      const run = ToolInvocation.run;
      let statuses = 0;
      spyOn(ToolInvocation, "run").mockImplementation(async (request) => {
        if (request.tool === "git" && request.args.includes("status") && ++statuses === 2)
          await Bun.write(`${input.cwd}/late.txt`, "keep");
        return run(request);
      });
    }
    device.answer((args) => {
      if (requestKind(args) !== "merge") return succeeded(pullRequestBody({ head }));
      if (stage === "refused") return failed("Refused");
      return stage === "identity" ? mergeRequest("pending", "u1") : mergeRequest("failed");
    });
    const detail = {
      identity:
        "The accepted request identity could not be saved. The delivery remains outstanding.",
      failed: "Could not settle the failed delivery.",
      refused: "Could not settle the refused delivery.",
      prewrite: "Could not settle the prewrite refusal.",
    }[stage];
    expect<unknown>(await merge(input)).toMatchObject({
      tag: "Err",
      error: {
        reason: stage === "identity" ? "pr_merge_unverified" : "pr_defect",
        detail,
        next: { decider: "super-agent", question: expect.stringMatching(/\S/) as unknown },
      },
    });
    expect<unknown>(DeviceState.readDelivery(device.paths, launchId)).toMatchObject({
      tag: "Ok",
      value: { endedAt: null, ownerPid: null },
    });
  },
);

test.each(["pending", "lost", "enqueued"] as const)(
  "%s delivery refuses a later hold after the command exits",
  async (status) => {
    const { device, head, input, launchId } = await owner();
    await using _ = device;
    device.answer((args) => {
      const kind = requestKind(args);
      if (kind === "merge" || kind === "merge_read")
        return status === "lost"
          ? uncertain("response lost")
          : mergeRequest(status, "outstanding-id");
      return succeeded(pullRequestBody({ head }));
    });
    expect((await merge(input)).tag).toBe("Err");
    expect<unknown>(
      DeviceState.changeObligation(
        device.paths,
        { repository, checkout: device.checkout, sourceId: device.sourceId },
        "hold",
        () =>
          Ok({
            insert: {
              sourceId: device.sourceId,
              key: "hold",
              kind: "merge-hold",
              summary: "Hold",
              reference: null,
              openedAt: "now",
              state: "open",
              closedAt: null,
            },
          }),
      ),
    ).toMatchObject({ tag: "Err", error: { reason: "pr_delivery_running" } });
    expect<unknown>(
      DeviceState.recordPullRequestWait(device.paths, launchId, () => ({
        progress: "{}",
        waitState: "waiting",
      })),
    ).toMatchObject({ tag: "Err", error: { reason: "pr_delivery_running" } });
    expect<unknown>(
      DeviceState.readObligations(device.paths, {
        repository,
        checkout: device.checkout,
        sourceId: device.sourceId,
      }),
    ).toMatchObject({ tag: "Ok", value: { obligations: [] } });
    device.answer((args) =>
      requestKind(args) === "merge_read"
        ? uncertain("still unknown")
        : succeeded(pullRequestBody({ head })),
    );
    expect((await merge(input)).tag).toBe("Err");
    expect(device.calls.filter((args) => requestKind(args) === "merge")).toHaveLength(1);
  },
);

test("work that changes after the claim cannot reach the GitHub mutation", async () => {
  const { device, head, input, detach } = await owner();
  await using _ = device;
  const run = ToolInvocation.run;
  let statuses = 0;
  spyOn(ToolInvocation, "run").mockImplementation(async (request) => {
    if (request.tool === "git" && request.args.includes("status") && ++statuses === 2)
      await Bun.write(`${input.cwd}/late-work.txt`, "keep late work\n");
    return run(request);
  });
  device.answer(() => succeeded(pullRequestBody({ head })));
  expect<unknown>(await merge(input)).toMatchObject({
    tag: "Err",
    error: {
      reason: "pr_worktree_unclean",
      detail:
        "The worktree changed during delivery. Reconcile it before retrying. Nothing was merged or removed.",
      next: { decider: "super-agent", question: expect.stringMatching(/\S/) as unknown },
    },
  });
  expect(device.calls.filter((args) => requestKind(args) === "merge")).toHaveLength(0);
  expect(detach).not.toHaveBeenCalled();
  expect(await Bun.file(`${input.cwd}/late-work.txt`).text()).toBe("keep late work\n");
});

test("a clean new commit after the claim cannot reach the SHA-pinned GitHub mutation", async () => {
  const { device, head, input, detach, launchId } = await owner();
  await using _ = device;
  const run = ToolInvocation.run;
  let statuses = 0;
  spyOn(ToolInvocation, "run").mockImplementation(async (request) => {
    if (request.tool === "git" && request.args.includes("status") && ++statuses === 2) {
      await Bun.write(`${input.cwd}/late-commit.txt`, "retained committed work\n");
      git(input.cwd, "add", "late-commit.txt");
      git(input.cwd, "commit", "-m", "Retain late work");
    }
    return run(request);
  });
  device.answer(() => succeeded(pullRequestBody({ head })));
  expect<unknown>(await merge(input)).toMatchObject({
    tag: "Err",
    error: { reason: "pr_worktree_unclean" },
  });
  expect(git(input.cwd, "status", "--porcelain")).toBe("");
  expect(git(input.cwd, "rev-parse", "HEAD")).not.toBe(head);
  expect(await Bun.file(`${input.cwd}/late-commit.txt`).text()).toBe("retained committed work\n");
  expect(device.calls.filter((args) => requestKind(args) === "merge")).toHaveLength(0);
  expect(detach).not.toHaveBeenCalled();
  expect<unknown>(DeviceState.readDelivery(device.paths, launchId)).toMatchObject({
    tag: "Ok",
    value: null,
  });
});

test("the supervising session delivers an idle owner's eligible PR through the pinned path", async () => {
  const { device, head, input } = await owner();
  await using _ = device;
  expect(
    DeviceState.takeOverSource(device.paths, repository, device.sourceId, {
      pane: "supervisor-pane",
      session: "supervisor",
    }).tag,
  ).toBe("Ok");
  spyOn(Environment, "caller").mockReturnValue({ pane: "supervisor-pane", session: "supervisor" });
  const selected = {
    ...input,
    cwd: device.checkout,
    sourceId: device.sourceId,
    assignment: "other",
  };
  device.answer(() => succeeded(pullRequestBody({ head })));
  expect<unknown>(await merge(selected)).toMatchObject({
    tag: "Err",
    error: { reason: "pr_owner_busy" },
  });
  expect(device.calls.filter((args) => requestKind(args) === "merge")).toHaveLength(0);
  expect(
    DeviceState.observePane(device.paths, {
      socket: `${device.root}/herdr.sock`,
      workspaceId: null,
      paneId: "p1",
      observation: { exited: false, activity: "idle" },
    }).tag,
  ).toBe("Ok");
  let landed = false;
  device.answer((args) => {
    if (requestKind(args) === "merge") {
      landed = true;
      return mergeRequest("merged");
    }
    return succeeded(
      pullRequestBody(landed ? { state: "MERGED", head, mergeCommit: "selected-merge" } : { head }),
    );
  });
  expect<unknown>(await merge(selected)).toMatchObject({
    tag: "Ok",
    value: {
      reason: "pr_merged",
      data: { assignment: "other", head, mergeCommit: "selected-merge" },
    },
  });
  expect(device.calls.filter((args) => requestKind(args) === "merge")).toHaveLength(1);
});

test("selected reconciliation does not close an active owner's pane after an external merge", async () => {
  const { device, head, input, detach } = await owner();
  await using _ = device;
  expect(
    DeviceState.takeOverSource(device.paths, repository, device.sourceId, {
      pane: "supervisor-pane",
      session: "supervisor",
    }).tag,
  ).toBe("Ok");
  spyOn(Environment, "caller").mockReturnValue({ pane: "supervisor-pane", session: "supervisor" });
  device.answer(() =>
    succeeded(pullRequestBody({ state: "MERGED", head, mergeCommit: "external" })),
  );
  expect<unknown>(
    await merge({ ...input, cwd: device.checkout, sourceId: device.sourceId, assignment: "other" }),
  ).toMatchObject({ tag: "Err", error: { reason: "pr_owner_busy" } });
  expect(detach).not.toHaveBeenCalled();
  expect(assignmentState(device)).toBe("pr-open");
  expect(
    DeviceState.observePane(device.paths, {
      socket: `${device.root}/herdr.sock`,
      paneId: "p1",
      workspaceId: null,
      observation: { exited: false, activity: "idle" },
    }).tag,
  ).toBe("Ok");
  expect<unknown>(
    await merge({ ...input, cwd: device.checkout, sourceId: device.sourceId, assignment: "other" }),
  ).toMatchObject({ tag: "Ok", value: { reason: "pr_merged", data: { mergeCommit: "external" } } });
  expect(device.calls.filter((args) => requestKind(args) === "merge")).toHaveLength(0);
});

test("a PR that GitHub already merged is verified and recorded without a merge request", async () => {
  const { device, head, input } = await owner();
  await using _ = device;
  device.answer(() =>
    succeeded(pullRequestBody({ state: "MERGED", head: "landed", mergeCommit: "m2" })),
  );
  expect<unknown>(await merge(input)).toEqual({
    tag: "Ok",
    value: { reason: "pr_merged", data: merged("landed", "m2") },
  });
  expect(device.calls.map(requestKind)).toEqual(["pull_request", "pull_request"]);
  expect(head).not.toBe("landed");
  expect(assignmentState(device)).toBe("merged");
});

test("a merged PR without a merge commit is not recorded", async () => {
  const { device, detach, input } = await owner();
  await using _ = device;
  device.answer(() => succeeded(pullRequestBody({ state: "MERGED", head: "landed" })));
  expect<unknown>(await merge(input)).toEqual({
    tag: "Err",
    error: {
      reason: "pr_merge_unverified",
      detail:
        "GitHub does not report PR #7 merged at landed. Nothing was recorded. Repeat operator pr merge.",
      next: verifyRecovery,
      state: {
        pullRequest: 7,
        expectedHead: "landed",
        observedState: "MERGED",
        observedHead: "landed",
      },
    },
  });
  expect(detach).not.toHaveBeenCalled();
  expect(assignmentState(device)).toBe("pr-open");
});

test("an owner without a recorded PR reads nothing from GitHub", async () => {
  await using device = await prDevice();
  const { worktree } = device.start("other");
  expect<unknown>(await merge({ paths: device.paths, cwd: worktree })).toEqual({
    tag: "Err",
    error: {
      reason: "pr_not_associated",
      detail: "Run operator pr associate after you open the PR. Nothing was merged or changed.",
      next: {
        command: "operator pr associate",
        why: "Associate the assignment's open PR before merging.",
      },
      state: { pullRequest: null },
    },
  });
  expect(device.calls).toEqual([]);
});

test("a refused gate sends no merge request and writes nothing", async () => {
  const { device, head, detach, input } = await owner();
  await using _ = device;
  const nothing = "Nothing was merged or changed.";
  for (const [facts, error] of [
    [
      { state: "CLOSED", head },
      {
        reason: "pr_not_open",
        detail: `The PR is closed without a merge. Ask the SuperAgent. ${nothing}`,
        result: "refused",
        conditions: passingConditions,
        next: {
          decider: "super-agent",
          question: "How should the closed PR assignment be resolved?",
        },
        state: { pullRequest: "CLOSED" },
      },
    ],
    [
      { head, approved: false },
      {
        reason: "pr_merge_blocked",
        detail: `The PR needs an approving review decision. ${nothing}`,
        result: "refused",
        conditions: { ...passingConditions, approved: false },
        next: {
          command: "operator pr wait",
          why: `The PR needs an approving review decision. ${nothing}`,
        },
        state: { conditions: { ...passingConditions, approved: false } },
      },
    ],
    [
      { head: "elsewhere" },
      {
        reason: "pr_head_mismatch",
        detail: `The PR head is elsewhere, but the worktree is at ${head}. Push or reconcile first. ${nothing}`,
        result: "refused",
        conditions: passingConditions,
        next: {
          decider: "super-agent",
          question: "How should the worktree and PR heads be reconciled without losing commits?",
        },
        state: { localHead: head, prHead: "elsewhere" },
      },
    ],
  ] as const) {
    device.answer(() => succeeded(pullRequestBody(facts)));
    expect<unknown>(await merge(input)).toEqual({ tag: "Err", error });
  }
  expect(device.calls.map(requestKind)).toEqual(["pull_request", "pull_request", "pull_request"]);
  expect(detach).not.toHaveBeenCalled();
  expect(assignmentState(device)).toBe("pr-open");
});

test("a worktree whose head Git cannot read never merges", async () => {
  const { device, input } = await owner();
  await using _ = device;
  device.answer(() => succeeded(pullRequestBody()));
  const run = ToolInvocation.run;
  const answers = [
    { status: "completed" as const, exitCode: 128, stdout: "h1\n", stderr: "fatal" },
    { status: "no-answer" as const, detail: "git ended" },
  ];
  for (const answer of answers) {
    spyOn(ToolInvocation, "run").mockImplementation(async (request) =>
      request.args[0] === "-C" ? answer : run(request),
    );
    expect<unknown>(await merge(input)).toMatchObject({
      tag: "Err",
      error: {
        reason: "pr_head_mismatch",
        detail: expect.stringContaining("but the worktree is at no commit.") as unknown,
      },
    });
  }
});

test("a stacked PR merges only after its relay finished", async () => {
  const relay = stacked(parent);
  const blocked = await owner(JSON.stringify(relay));
  await using _ = blocked.device;
  blocked.device.answer(() => succeeded(pullRequestBody({ head: blocked.head })));
  expect<unknown>(await merge(blocked.input)).toEqual({
    tag: "Err",
    error: {
      reason: "pr_merge_blocked",
      detail: "The PR needs a finished parent-merge relay. Nothing was merged or changed.",
      result: "refused",
      conditions: { ...passingConditions, stackRelayed: false },
      next: {
        command: "operator pr wait",
        why: "The PR needs a finished parent-merge relay. Nothing was merged or changed.",
      },
      state: { conditions: { ...passingConditions, stackRelayed: false } },
    },
  });
  mock.restore();
  const relayed = await owner(JSON.stringify({ ...relay, state: "relayed" }));
  await using __ = relayed.device;
  let landed = false;
  relayed.device.answer((args) => {
    if (requestKind(args) === "merge") {
      landed = true;
      return mergeRequest("merged");
    }
    return succeeded(
      pullRequestBody(
        landed
          ? { state: "MERGED", head: relayed.head, mergeCommit: "m1" }
          : { head: relayed.head },
      ),
    );
  });
  expect<unknown>(await merge(relayed.input)).toMatchObject({
    tag: "Ok",
    value: { reason: "pr_merged" },
  });
});

test("every merge answer is verified against GitHub's state", async () => {
  const { device, head } = await owner();
  await using _ = device;
  const cases = [
    {
      answer: failed("Head branch was modified"),
      error: {
        reason: "pr_merge_refused",
        detail: "github_refused: Head branch was modified",
        next: refusedRecovery,
      },
    },
    {
      answer: uncertain("gh ended on SIGTERM"),
      error: { reason: "github_uncertain", detail: "gh ended on SIGTERM", next: effectRecovery },
    },
    {
      answer: mergeRequest("merged"),
      error: {
        reason: "pr_merge_unverified",
        detail: `GitHub does not report PR #7 merged at ${head}. Nothing was recorded. Repeat operator pr merge.`,
        next: verifyRecovery,
        state: { pullRequest: 7, expectedHead: head, observedState: "OPEN", observedHead: head },
      },
    },
    {
      answer: mergeRequest("failed"),
      error: { reason: "pr_merge_refused", detail: "Request failed.", next: refusedRecovery },
    },
    {
      answer: mergeRequest("enqueued"),
      error: {
        reason: "pr_merge_unverified",
        detail:
          "GitHub put the PR in a merge queue: Request enqueued. Nothing was recorded. Repeat operator pr merge after it merges.",
        next: {
          command: "operator pr merge",
          why: "Verify the queued merge after GitHub reports it merged.",
        },
        state: { mergeRequest: "enqueued" },
      },
    },
    {
      answer: succeeded({ merged: true }),
      error: {
        reason: "github_uncertain",
        detail: "GitHub did not describe the merge request in the expected form.",
        next: effectRecovery,
      },
    },
  ];
  for (const { answer, error } of cases) {
    mock.restore();
    const trial = await owner();
    await using _trial = trial.device;
    trial.device.answer((args) =>
      requestKind(args) === "merge" ? answer : succeeded(pullRequestBody({ head: trial.head })),
    );
    const expected = { ...error, detail: error.detail.replaceAll(head, trial.head) };
    if (expected.state !== undefined && "expectedHead" in expected.state)
      expected.state = {
        pullRequest: 7,
        expectedHead: trial.head,
        observedState: "OPEN",
        observedHead: trial.head,
      };
    expect<unknown>(await merge(trial.input)).toEqual({ tag: "Err", error: expected });
  }
});

test("a merge of a newer head is not the guarded merge", async () => {
  const { device, head, input } = await owner();
  await using _ = device;
  // A merge of a newer head is not the guarded merge.
  device.answer((args) =>
    requestKind(args) === "merge"
      ? mergeRequest("merged")
      : succeeded(
          pullRequestBody(
            device.calls.length > 1
              ? { state: "MERGED", head: "newer", mergeCommit: "m3" }
              : { head },
          ),
        ),
  );
  device.calls.length = 0;
  expect<unknown>(await merge(input)).toMatchObject({
    tag: "Err",
    error: { reason: "pr_merge_unverified" },
  });
  expect(assignmentState(device)).toBe("pr-open");
});

test("a background merge is read until it ends, and pr_merged waits for GitHub's merged PR", async () => {
  const { device, head, input } = await owner();
  await using _ = device;
  device.answer((args) => {
    const kind = requestKind(args);
    return kind === "merge" || kind === "merge_read"
      ? mergeRequest("pending", "u1")
      : succeeded(pullRequestBody({ head }));
  });
  expect<unknown>(await merge(input)).toEqual({
    tag: "Err",
    error: {
      reason: "pr_merge_unverified",
      detail:
        "GitHub still runs the merge request: Request pending. Nothing was recorded. Repeat operator pr merge.",
      next: {
        command: "operator pr merge",
        why: "Verify whether the background merge request landed.",
      },
      state: { mergeRequest: "pending" },
    },
  });
  expect(device.calls.filter((args) => requestKind(args) === "merge_read")).toHaveLength(120);
  expect(assignmentState(device)).toBe("pr-open");

  // A read that GitHub refuses or loses ends the reads, and the PR state still decides.
  for (const [read, error] of [
    [
      failed("Not Found", 404),
      {
        reason: "pr_merge_unverified",
        detail:
          "GitHub did not answer the merge request read: github_refused: Not Found. Nothing was recorded. Repeat operator pr merge.",
        next: verifyRecovery,
      },
    ],
    [
      uncertain("gh ended on SIGTERM"),
      { reason: "github_uncertain", detail: "gh ended on SIGTERM", next: effectRecovery },
    ],
  ] as const) {
    device.calls.length = 0;
    device.answer((args) => {
      const kind = requestKind(args);
      if (kind === "merge") return mergeRequest("pending", "u1");
      return kind === "merge_read" ? read : succeeded(pullRequestBody({ head }));
    });
    expect<unknown>(await merge(input)).toEqual({ tag: "Err", error });
    expect(device.calls.map(requestKind)).toEqual(["pull_request", "merge_read", "pull_request"]);
  }
});

test("an existing request without an identity remains blocked", async () => {
  const { device, head, input } = await owner();
  await using _ = device;
  // A request that GitHub already runs for this PR is not a refusal, and the PR state decides.
  device.calls.length = 0;
  device.answer((args) =>
    requestKind(args) === "merge"
      ? failed("A merge request already exists for this pull request.", 409)
      : succeeded(pullRequestBody({ head })),
  );
  expect<unknown>(await merge(input)).toEqual({
    tag: "Err",
    error: {
      reason: "pr_merge_unverified",
      detail:
        "GitHub still runs the merge request: GitHub already runs a merge request for this PR. Nothing was recorded. Repeat operator pr merge.",
      next: {
        command: "operator pr merge",
        why: "Verify whether the background merge request landed.",
      },
      state: { mergeRequest: "pending" },
    },
  });
  expect(device.calls.map(requestKind)).toEqual(["pull_request", "merge", "pull_request"]);
  expect(assignmentState(device)).toBe("pr-open");
});

test("a refused or lost merge answer still records a merge that landed", async () => {
  const { device, head, input } = await owner();
  await using _ = device;
  let landed = false;
  device.answer((args) => {
    if (requestKind(args) === "merge") {
      landed = true;
      return uncertain("gh ended on SIGTERM");
    }
    return succeeded(
      pullRequestBody(landed ? { state: "MERGED", head, mergeCommit: "m1" } : { head }),
    );
  });
  expect<unknown>(await merge(input)).toMatchObject({ tag: "Ok", value: { reason: "pr_merged" } });
});

test("a merge request that throws is a defect unless GitHub shows the merge", async () => {
  const { device, head, input } = await owner();
  await using _ = device;
  const call = device.answer;
  call((args) => {
    if (requestKind(args) === "merge") return Promise.reject(new Error("boom"));
    return succeeded(pullRequestBody({ head }));
  });
  expect<unknown>(await merge(input)).toEqual({
    tag: "Err",
    error: {
      reason: "pr_defect",
      detail: "Error: boom",
      next: {
        decider: "super-agent",
        question: "How should the unexpected merge failure be investigated before another request?",
      },
    },
  });
});

test("a cleanup that cannot start fails after the merge is recorded", async () => {
  const { device, head, detach, input, launchId } = await owner();
  await using _ = device;
  let landed = false;
  device.answer((args) => {
    if (requestKind(args) === "merge") {
      landed = true;
      return mergeRequest("merged");
    }
    return succeeded(
      pullRequestBody(landed ? { state: "MERGED", head, mergeCommit: "m1" } : { head }),
    );
  });
  detach.mockImplementation(() => {
    // oxlint-disable-next-line unthrown/no-throw -- The detached start throws like a failed spawn.
    throw Object.assign(new Error("ENOENT: no bun"), { code: "ENOENT" });
  });
  expect<unknown>(await merge(input)).toEqual({
    tag: "Err",
    error: {
      reason: "pr_io_failed",
      detail: "Error: ENOENT: no bun",
      next: {
        decider: "super-agent",
        question: "How should the PR worktree IO failure be corrected without losing work?",
      },
      state: { code: "ENOENT" },
    },
  });
  expect(assignmentState(device)).toBe("merged");
  expect<unknown>(DeviceState.readDelivery(device.paths, launchId)).toMatchObject({
    tag: "Ok",
    value: null,
  });
});

test("the merge of the last open assignment finishes its source", async () => {
  const { device, head, input } = await owner(null, ["other"]);
  await using _ = device;
  device.answer(() => succeeded(pullRequestBody({ state: "MERGED", head, mergeCommit: "m1" })));
  expect<unknown>(await merge(input)).toMatchObject({ tag: "Ok", value: { reason: "pr_merged" } });
  expect<unknown>(DeviceState.readSources(device.paths, repository, device.sourceId)).toMatchObject(
    {
      tag: "Ok",
      value: [{ source: { state: "finished" } }],
    },
  );
});

test("a merge that another process recorded first is unchanged", async () => {
  const { device, head, input } = await owner();
  await using _ = device;
  device.answer(() => succeeded(pullRequestBody({ state: "MERGED", head, mergeCommit: "m1" })));
  spyOn(DeviceState, "recordPullRequestMerge").mockReturnValue(Ok({ changed: false }));
  expect<unknown>(await merge(input)).toEqual({
    tag: "Ok",
    value: { reason: "pr_merge_unchanged", data: { ...merged(head), sourceId: device.sourceId } },
  });
});
