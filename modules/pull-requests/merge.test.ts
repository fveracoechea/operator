import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Ok } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import {
  failed,
  git,
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

/** A running owner of `other` with PR #7 recorded, and a cleanup start that never runs. */
async function owner(relay: string | null = null, assignments?: string[]) {
  const device = await prDevice({ assignments });
  const started = device.start("other");
  device.associate(started.launchId, 7, "task/other", relay);
  const head = git(started.worktree, "rev-parse", "HEAD");
  // A live process that is not this one, so the recorded cleanup stays visibly running.
  const detach = spyOn(ToolInvocation, "detach").mockReturnValue(process.ppid);
  return {
    device,
    ...started,
    head,
    detach,
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
  const { device, head, detach, input } = await owner();
  await using _ = device;
  let landed = false;
  device.answer((args) => {
    const kind = requestKind(args);
    if (kind === "merge") {
      landed = true;
      return succeeded({ merged: true });
    }
    return succeeded(
      pullRequestBody(landed ? { state: "MERGED", head, mergeCommit: "m1" } : { head }),
    );
  });
  expect<unknown>(await merge(input)).toEqual({
    tag: "Ok",
    value: { reason: "pr_merged", data: { ...merged(head), sourceId: device.sourceId } },
  });
  expect(device.calls.map(requestKind)).toEqual(["pull_request", "merge", "pull_request"]);
  expect(device.calls[1]).toEqual([
    "-X",
    "PUT",
    `repos/${repository}/pulls/7/merge`,
    "-f",
    `sha=${head}`,
    "-f",
    "merge_method=squash",
  ]);
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
      },
    ],
    [
      { head, approved: false },
      {
        reason: "pr_merge_blocked",
        detail: `The PR needs an approving review decision. ${nothing}`,
      },
    ],
    [
      { head: "elsewhere" },
      {
        reason: "pr_head_mismatch",
        detail: `The PR head is elsewhere, but the worktree is at ${head}. Push or reconcile first. ${nothing}`,
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
    },
  });
  mock.restore();
  const relayed = await owner(JSON.stringify({ ...relay, state: "relayed" }));
  await using __ = relayed.device;
  let landed = false;
  relayed.device.answer((args) => {
    if (requestKind(args) === "merge") landed = true;
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
      error: { reason: "pr_merge_refused", detail: "github_refused: Head branch was modified" },
    },
    {
      answer: uncertain("gh ended on SIGTERM"),
      error: { reason: "github_uncertain", detail: "gh ended on SIGTERM" },
    },
    {
      answer: succeeded({ merged: true }),
      error: {
        reason: "pr_merge_unverified",
        detail: `GitHub does not report PR #7 merged at ${head}. Nothing was recorded. Repeat operator pr merge.`,
      },
    },
  ];
  for (const { answer, error } of cases) {
    device.answer((args) =>
      requestKind(args) === "merge" ? answer : succeeded(pullRequestBody({ head })),
    );
    expect<unknown>(await merge(input)).toEqual({ tag: "Err", error });
  }
  // A merge of a newer head is not the guarded merge.
  device.answer((args) =>
    requestKind(args) === "merge"
      ? succeeded({ merged: true })
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
    error: { reason: "pr_defect", detail: "Error: boom" },
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
    error: { reason: "pr_io_failed", detail: "Error: ENOENT: no bun" },
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
