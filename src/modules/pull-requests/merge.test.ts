import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Ok } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
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
async function owner(
  relay: string | null = null,
  assignments?: string[],
  typed = false,
  ready = true,
  reviewState?: "ready" | "skipped",
) {
  const device = await prDevice({ assignments });
  const outgoing = device.start("other", {
    kind: typed ? JSON.stringify(WorkerKinds.resolve("implementation")) : null,
  });
  const head = git(outgoing.worktree, "rev-parse", "HEAD");
  const readiness = {
    head,
    at: new Date().toISOString(),
    note: null,
    dispositions: [],
  };
  let started = outgoing;
  if (reviewState === undefined)
    device.associate(outgoing.launchId, 7, "task/other", relay, ready ? readiness : undefined);
  else {
    expect(
      DeviceState.associatePullRequest(
        device.paths,
        outgoing.launchId,
        {
          number: 7,
          url: "https://github.com/example/one/pull/7",
          branch: "task/other",
          relay,
        },
        false,
        true,
      ).tag,
    ).toBe("Ok");
    expect(DeviceState.finishImplementer(device.paths, outgoing.launchId).tag).toBe("Ok");
    started = device.start("other", {
      worktree: outgoing.worktree,
      add: false,
      kind: JSON.stringify(WorkerKinds.resolve("review")),
    });
    if (reviewState === "skipped")
      expect(
        DeviceState.endInternalReview(
          device.paths,
          {
            sourceId: device.sourceId,
            assignment: "other",
            launchId: null,
          },
          { state: "skipped", readyHead: null, commentId: null, commentUrl: null },
          false,
        ).tag,
      ).toBe("Ok");
    expect(
      DeviceState.endInternalReview(
        device.paths,
        {
          sourceId: device.sourceId,
          assignment: "other",
          launchId: started.launchId,
        },
        { state: reviewState, readyHead: head, commentId: null, commentUrl: null, readiness },
        false,
      ).tag,
    ).toBe("Ok");
  }
  if (ready) {
    expect(DeviceState.finishImplementer(device.paths, started.launchId).tag).toBe("Ok");
    started = device.start("other", {
      worktree: outgoing.worktree,
      add: false,
      kind: typed ? JSON.stringify(WorkerKinds.resolve("pr-feedback")) : null,
    });
  }
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

test("a typed merge owner refuses hidden untracked work before requesting a merge", async () => {
  const { device, head, input, launchId, worktree, detach } = await owner(null, undefined, true);
  await using _ = device;
  expect(
    DeviceState.recordPullRequestWait(device.paths, launchId, () => ({
      progress: JSON.stringify({ seen: [], failures: [], eligibleHead: head }),
      waitState: "idle",
    })).tag,
  ).toBe("Ok");
  git(worktree, "config", "status.showUntrackedFiles", "no");
  await Bun.write(`${worktree}/pending.txt`, "Keep.");
  device.answer(() => succeeded(pullRequestBody({ head })));
  expect<unknown>(await merge(input)).toMatchObject({
    tag: "Err",
    error: { reason: "pr_worktree_unclean", state: { worktree_clean: false } },
  });
  expect(device.calls.map(requestKind)).toEqual(["pull_request"]);
  expect(detach).not.toHaveBeenCalled();
  expect(assignmentState(device)).toBe("pr-open");
  expect(await Bun.file(`${worktree}/pending.txt`).text()).toBe("Keep.");
});

test("a typed merge owner without a ready frontier refuses without side effects", async () => {
  const { device, head, input, detach } = await owner(null, undefined, true, false);
  await using _ = device;
  device.answer(() => succeeded(pullRequestBody({ head })));
  expect<unknown>(await merge(input)).toMatchObject({
    tag: "Err",
    error: {
      reason: "pr_merge_blocked",
      conditions: { reviewEnded: false },
      state: { conditions: { reviewEnded: false } },
    },
  });
  expect(device.calls.map(requestKind)).toEqual(["pull_request"]);
  expect(detach).not.toHaveBeenCalled();
  expect(assignmentState(device)).toBe("pr-open");
});

test.each(["ready", "skipped"] as const)(
  "a typed %s review frontier still requires a fresh gate before merging",
  async (reviewState) => {
    const { device, head, input, detach } = await owner(null, undefined, true, true, reviewState);
    await using _ = device;
    device.answer(() => succeeded(pullRequestBody({ head, approved: false })));
    expect<unknown>(await merge(input)).toMatchObject({
      tag: "Err",
      error: { reason: "pr_merge_blocked" },
    });
    expect(device.calls.map(requestKind)).toEqual(["pull_request"]);
    expect(detach).not.toHaveBeenCalled();
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
    expect<unknown>(await merge(input)).toMatchObject({
      tag: "Ok",
      value: { reason: "pr_merged" },
    });
    expect(device.calls.map(requestKind)).toEqual([
      "pull_request",
      "pull_request",
      "merge",
      "pull_request",
    ]);
    expect(detach).toHaveBeenCalledTimes(1);
  },
);

test("a typed already merged owner verifies and starts cleanup even with hidden untracked work", async () => {
  const { device, input, worktree, detach } = await owner(null, undefined, true);
  await using _ = device;
  git(worktree, "config", "status.showUntrackedFiles", "no");
  await Bun.write(`${worktree}/pending.txt`, "Keep.");
  device.answer(() =>
    succeeded(pullRequestBody({ state: "MERGED", head: "landed", mergeCommit: "m2" })),
  );
  expect<unknown>(await merge(input)).toMatchObject({ tag: "Ok", value: { reason: "pr_merged" } });
  expect(device.calls.map(requestKind)).toEqual(["pull_request", "pull_request"]);
  expect(detach).toHaveBeenCalledTimes(1);
  expect(await Bun.file(`${worktree}/pending.txt`).text()).toBe("Keep.");
});

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
        expectedHead: null,
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
  const { device, head, input } = await owner();
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
    device.calls.length = 0;
    device.answer((args) =>
      requestKind(args) === "merge" ? answer : succeeded(pullRequestBody({ head })),
    );
    expect<unknown>(await merge(input)).toEqual({ tag: "Err", error });
  }
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
    expect(device.calls.map(requestKind)).toEqual([
      "pull_request",
      "merge",
      "merge_read",
      "pull_request",
    ]);
  }

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
  const { device, head, detach, input } = await owner();
  await using _ = device;
  device.answer(() => succeeded(pullRequestBody({ state: "MERGED", head, mergeCommit: "m1" })));
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
