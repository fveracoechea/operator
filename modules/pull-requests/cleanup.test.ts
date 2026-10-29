import { afterEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import { Err, ErrAsync, OkAsync } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { WorktreePreparation } from "../worktree-preparation/main.ts";
import { cleanup } from "./cleanup.ts";
import {
  commit,
  failed,
  git,
  prDevice,
  repository,
  requestKind,
  succeeded,
  uncertain,
} from "./device-fixture.ts";

afterEach(() => {
  mock.restore();
});

const person =
  "Only the person can authorize its deletion: repeat operator cleanup with --person-instructed on the person's instruction.";
const allSteps = [
  { step: "remote_branch", outcome: "deleted" },
  { step: "pane", outcome: "closed" },
  { step: "worktree", outcome: "removed" },
];

type Start = Parameters<Awaited<ReturnType<typeof prDevice>>["start"]>[1];

/**
 * A verified merge of `other` at the worktree head, in pane `p1` of tab `t1`, inside the Herdr
 * session that started it. GitHub holds the branch at the merged head until it is deleted.
 */
async function mergedOwner(options: Start = {}) {
  const device = await prDevice();
  const started = device.start("other", options);
  const head =
    started.worktree === ""
      ? git(device.checkout, "rev-parse", "HEAD")
      : await work(started.worktree);
  device.associate(started.launchId, 7, "task/other");
  device.merged(started.launchId, 7, head);
  const environment = Environment.read();
  spyOn(Environment, "read").mockReturnValue({
    ...environment,
    HERDR_SOCKET_PATH: `${device.root}/herdr.sock`,
  });
  const herdr = {
    pane: spyOn(Herdr, "pane").mockReturnValue(OkAsync({ tabId: "t1", workspaceId: "w1" })),
    closePane: spyOn(Herdr, "closePane").mockReturnValue(OkAsync("closed" as const)),
    workspaces: spyOn(Herdr, "workspaces").mockReturnValue(OkAsync([])),
    removeWorktree: spyOn(Herdr, "removeWorktree").mockReturnValue(OkAsync(undefined)),
  };
  let remote: string | null = head;
  device.answer((args) => {
    const kind = requestKind(args);
    if (kind === "delete_branch") {
      remote = null;
      return succeeded(null, 204);
    }
    return remote === null ? failed("Not Found", 404) : succeeded({ object: { sha: remote } });
  });
  const request = {
    paths: device.paths,
    cwd: device.checkout,
    sourceId: device.sourceId,
    assignment: "other",
    personInstructed: false,
  };
  return { device, ...started, head, herdr, request };
}

async function work(worktree: string) {
  return commit(worktree, "work.txt", "work\n");
}

function recorded(device: Awaited<ReturnType<typeof prDevice>>) {
  const claimed = DeviceState.claimCleanup(device.paths, repository, device.sourceId, "other");
  return claimed.tag === "Ok" ? claimed.value.cleanup : claimed;
}

function branches(device: Awaited<ReturnType<typeof prDevice>>) {
  return git(device.checkout, "branch", "--list", "task/other");
}

function data(device: Awaited<ReturnType<typeof prDevice>>, steps: unknown[]) {
  return { sourceId: device.sourceId, assignment: "other", steps };
}

test("a verified merge disposes the remote branch, the pane, and the worktree in order", async () => {
  const owner = await mergedOwner();
  await using device = owner.device;
  expect<unknown>(await cleanup(owner.request)).toEqual({
    tag: "Ok",
    value: { reason: "cleanup_finished", data: data(device, allSteps) },
  });
  expect(device.calls).toEqual([
    [`repos/${repository}/git/ref/heads/task/other`],
    ["-X", "DELETE", `repos/${repository}/git/refs/heads/task/other`],
    [`repos/${repository}/git/ref/heads/task/other`],
  ]);
  expect(owner.herdr.pane.mock.calls).toEqual([["p1"]]);
  expect(owner.herdr.closePane.mock.calls).toEqual([["p1"]]);
  expect(owner.herdr.removeWorktree).not.toHaveBeenCalled();
  expect<unknown>(await Bun.file(`${owner.worktree}/work.txt`).exists()).toBe(false);
  expect(branches(device)).toBe("");
  expect<unknown>(recorded(device)).toMatchObject({ step: null, state: "done", reason: null });
  // A finished cleanup changes nothing when it is repeated.
  expect<unknown>(await cleanup(owner.request)).toEqual({
    tag: "Ok",
    value: { reason: "cleanup_unchanged", data: data(device, []) },
  });
  expect(device.calls).toHaveLength(3);
});

test("a cleanup outside the registered project or without a merge changes nothing", async () => {
  const owner = await mergedOwner();
  await using device = owner.device;
  expect<unknown>(await cleanup({ ...owner.request, cwd: owner.device.root })).toMatchObject({
    tag: "Err",
  });
  expect<unknown>(await cleanup({ ...owner.request, assignment: "parent" })).toMatchObject({
    tag: "Err",
    error: { reason: "cleanup_not_found" },
  });
  expect(device.calls).toEqual([]);
});

test("an absent remote branch is not deleted", async () => {
  const owner = await mergedOwner();
  await using device = owner.device;
  device.answer(() => failed("Not Found", 404));
  expect<unknown>(await cleanup(owner.request)).toMatchObject({
    tag: "Ok",
    value: { data: { steps: [{ step: "remote_branch", outcome: "absent" }, {}, {}] } },
  });
  expect(device.calls.map(requestKind)).toEqual(["branch"]);
});

test("a moved remote branch blocks until the person instructs its deletion", async () => {
  const owner = await mergedOwner();
  await using device = owner.device;
  let remote: string | null = "moved";
  device.answer((args) => {
    if (requestKind(args) === "delete_branch") {
      remote = null;
      return succeeded(null, 204);
    }
    return remote === null ? failed("Not Found", 404) : succeeded({ object: { sha: remote } });
  });
  const detail = `The remote branch task/other is at moved, not at the merged head ${owner.head}. ${person}`;
  // The instruction covers only a blocked step whose detail the person read.
  expect<unknown>(await cleanup({ ...owner.request, personInstructed: true })).toEqual({
    tag: "Err",
    error: { reason: "cleanup_unlanded_work", detail: `remote_branch: ${detail}` },
  });
  expect<unknown>(recorded(device)).toMatchObject({
    step: "remote_branch",
    state: "blocked",
    reason: "cleanup_unlanded_work",
    detail,
  });
  expect<unknown>(await cleanup(owner.request)).toMatchObject({
    tag: "Err",
    error: { reason: "cleanup_unlanded_work" },
  });
  expect(device.calls.map(requestKind)).toEqual(["branch", "branch"]);
  expect<unknown>(await cleanup({ ...owner.request, personInstructed: true })).toEqual({
    tag: "Ok",
    value: { reason: "cleanup_finished", data: data(device, allSteps) },
  });
});

test("an unreadable or undeleted remote branch fails the step and stops the order", async () => {
  const owner = await mergedOwner();
  await using device = owner.device;
  const cases: [(args: string[]) => ReturnType<typeof succeeded>, string][] = [
    [() => failed("Server Error", 500), "github_failed: github_refused: Server Error"],
    [() => uncertain("gh ended"), "github_uncertain: gh ended"],
    [
      () => succeeded({ ref: "unexpected" }),
      "github_invalid_response: GitHub did not describe the branch task/other in the expected form.",
    ],
    [
      (args) =>
        requestKind(args) === "delete_branch"
          ? succeeded(null, 204)
          : succeeded({ object: { sha: owner.head } }),
      "github_failed: The branch task/other still exists after the deletion request.",
    ],
    [
      (args) =>
        requestKind(args) === "delete_branch"
          ? failed("Reference is protected", 422)
          : succeeded({ object: { sha: owner.head } }),
      "github_failed: The branch task/other still exists after the deletion request. github_refused: Reference is protected",
    ],
  ];
  for (const [answer, detail] of cases) {
    device.answer(answer);
    expect<unknown>(await cleanup(owner.request)).toEqual({
      tag: "Err",
      error: { reason: "cleanup_failed", detail: `remote_branch: ${detail}` },
    });
    expect<unknown>(recorded(device)).toMatchObject({
      step: "remote_branch",
      state: "failed",
      reason: "cleanup_failed",
      detail,
    });
  }
  expect(owner.herdr.pane).not.toHaveBeenCalled();
});

test("a deletion request that throws is kept in the failure detail", async () => {
  const owner = await mergedOwner();
  await using device = owner.device;
  device.answer((args) => {
    if (requestKind(args) === "delete_branch") return Promise.reject(new Error("boom"));
    return succeeded({ object: { sha: owner.head } });
  });
  expect<unknown>(await cleanup(owner.request)).toEqual({
    tag: "Err",
    error: {
      reason: "cleanup_failed",
      detail:
        "remote_branch: github_failed: The branch task/other still exists after the deletion request. Error: boom",
    },
  });
  device.answer((args) => {
    if (requestKind(args) === "delete_branch") return succeeded(null, 204);
    return Promise.reject(new Error("read boom"));
  });
  expect<unknown>(await cleanup(owner.request)).toEqual({
    tag: "Err",
    error: { reason: "cleanup_failed", detail: "remote_branch: cleanup_defect: Error: read boom" },
  });
});

test("only the recorded pane in the recorded Herdr session closes", async () => {
  const owner = await mergedOwner();
  await using device = owner.device;
  const environment = Environment.read();
  spyOn(Environment, "read").mockReturnValue({
    ...environment,
    HERDR_SOCKET_PATH: `${device.root}/other.sock`,
  });
  expect<unknown>(await cleanup(owner.request)).toEqual({
    tag: "Err",
    error: {
      reason: "cleanup_failed",
      detail:
        "pane: herdr_session_mismatch: Run operator cleanup in a pane of the Herdr session that started the worker.",
    },
  });
  expect(owner.herdr.pane).not.toHaveBeenCalled();
  expect<unknown>(recorded(device)).toMatchObject({ step: "pane", state: "failed" });
  spyOn(Environment, "read").mockReturnValue({
    ...environment,
    HERDR_SOCKET_PATH: `${device.root}/herdr.sock`,
  });
  // The repeat continues at the failed step and never reads the remote branch again.
  owner.herdr.pane.mockReturnValue(OkAsync({ tabId: "t9", workspaceId: "w1" }));
  expect<unknown>(await cleanup(owner.request)).toEqual({
    tag: "Ok",
    value: {
      reason: "cleanup_finished",
      data: data(device, [
        { step: "pane", outcome: "replaced" },
        { step: "worktree", outcome: "removed" },
      ]),
    },
  });
  expect(device.calls.map(requestKind)).toEqual(["branch", "delete_branch", "branch"]);
  expect(owner.herdr.closePane).not.toHaveBeenCalled();
});

test("a gone pane is absent and a Herdr failure fails the pane step", async () => {
  const owner = await mergedOwner();
  await using _ = owner.device;
  const failure = { reason: "herdr_failed" as const, detail: "herdr exited 1" };
  owner.herdr.pane.mockReturnValue(ErrAsync(failure));
  expect<unknown>(await cleanup(owner.request)).toEqual({
    tag: "Err",
    error: { reason: "cleanup_failed", detail: "pane: herdr_failed: herdr exited 1" },
  });
  owner.herdr.pane.mockReturnValue(OkAsync({ tabId: "t1", workspaceId: "w1" }));
  owner.herdr.closePane.mockReturnValue(ErrAsync(failure));
  expect<unknown>(await cleanup(owner.request)).toEqual({
    tag: "Err",
    error: { reason: "cleanup_failed", detail: "pane: herdr_failed: herdr exited 1" },
  });
  owner.herdr.pane.mockReturnValue(OkAsync(null));
  expect<unknown>(await cleanup(owner.request)).toMatchObject({
    tag: "Ok",
    value: { data: { steps: [{ step: "pane", outcome: "absent" }, { step: "worktree" }] } },
  });
  expect(owner.herdr.closePane).toHaveBeenCalledTimes(1);
});

test("a launch without a pane or a worktree skips those steps", async () => {
  const owner = await mergedOwner({ paneId: null, worktree: null, socket: null });
  await using device = owner.device;
  expect<unknown>(await cleanup(owner.request)).toEqual({
    tag: "Ok",
    value: {
      reason: "cleanup_finished",
      data: data(device, [
        { step: "remote_branch", outcome: "deleted" },
        { step: "pane", outcome: "not_recorded" },
        { step: "worktree", outcome: "not_recorded" },
      ]),
    },
  });
  expect(owner.herdr.pane).not.toHaveBeenCalled();
});

test("a pane in a Herdr session without a recorded socket needs no session variable", async () => {
  const owner = await mergedOwner({ socket: null });
  await using device = owner.device;
  const environment = Environment.read();
  spyOn(Environment, "read").mockReturnValue({ ...environment, HERDR_SOCKET_PATH: undefined });
  expect<unknown>(await cleanup(owner.request)).toMatchObject({
    tag: "Ok",
    value: { data: data(device, allSteps) },
  });
});

test("an already removed worktree drops its registration and its landed branch", async () => {
  const owner = await mergedOwner();
  await using device = owner.device;
  await rm(owner.worktree, { recursive: true, force: true });
  expect<unknown>(await cleanup(owner.request)).toMatchObject({
    tag: "Ok",
    value: { data: { steps: [{}, {}, { step: "worktree", outcome: "absent" }] } },
  });
  expect(branches(device)).toBe("");
  expect(git(device.checkout, "worktree", "list", "--porcelain")).not.toContain(owner.worktree);
});

test("an already removed worktree keeps an unlanded local branch", async () => {
  const owner = await mergedOwner();
  await using device = owner.device;
  await commit(owner.worktree, "late.txt", "late\n");
  await rm(owner.worktree, { recursive: true, force: true });
  expect<unknown>(await cleanup(owner.request)).toMatchObject({
    tag: "Ok",
    value: {
      data: { steps: [{}, {}, { step: "worktree", outcome: "absent, local branch kept" }] },
    },
  });
  expect(branches(device)).toContain("task/other");
});

test("an already removed worktree without its local branch is absent", async () => {
  const owner = await mergedOwner();
  await using device = owner.device;
  await rm(owner.worktree, { recursive: true, force: true });
  git(device.checkout, "worktree", "prune");
  git(device.checkout, "branch", "-q", "-D", "task/other");
  expect<unknown>(await cleanup(owner.request)).toMatchObject({
    tag: "Ok",
    value: { data: { steps: [{}, {}, { step: "worktree", outcome: "absent" }] } },
  });
});

function blocked(device: Awaited<ReturnType<typeof prDevice>>, reason: string, detail: string) {
  expect<unknown>(recorded(device)).toMatchObject({
    step: "worktree",
    state: "blocked",
    reason,
    detail,
  });
  return { tag: "Err", error: { reason, detail: `worktree: ${detail}` } };
}

test("a foreign checkout or another branch at the recorded path is never removed", async () => {
  const owner = await mergedOwner();
  await using device = owner.device;
  git(owner.worktree, "switch", "-q", "-c", "elsewhere");
  const detail = `${owner.worktree} is no longer the recorded worktree on task/other. Operator never removes another checkout. Move it away, then repeat operator cleanup.`;
  const result = await cleanup({ ...owner.request, personInstructed: true });
  expect<unknown>(result).toEqual(blocked(device, "cleanup_resource_mismatch", detail));
  git(owner.worktree, "switch", "-q", "task/other");
  git(device.checkout, "worktree", "remove", "--force", owner.worktree);
  await Bun.write(`${owner.worktree}/README.md`, "foreign\n", { createPath: true });
  git(owner.worktree, "init", "-q", "-b", "task/other");
  expect<unknown>(await cleanup({ ...owner.request, personInstructed: true })).toEqual(
    blocked(device, "cleanup_resource_mismatch", detail),
  );
  expect<unknown>(await Bun.file(`${owner.worktree}/README.md`).text()).toBe("foreign\n");
});

test("an unfinished cleanup without a recorded step runs no step", async () => {
  const owner = await mergedOwner();
  await using device = owner.device;
  const claim = DeviceState.claimCleanup;
  spyOn(DeviceState, "claimCleanup").mockImplementation((...args) =>
    claim(...args).map((facts) => ({ ...facts, cleanup: { ...facts.cleanup, step: null } })),
  );
  expect<unknown>(await cleanup(owner.request)).toEqual({
    tag: "Ok",
    value: { reason: "cleanup_finished", data: data(device, []) },
  });
  expect(device.calls).toEqual([]);
  expect(owner.herdr.pane).not.toHaveBeenCalled();
  expect<unknown>(await Bun.file(`${owner.worktree}/work.txt`).exists()).toBe(true);
});

test("a nested folder of the controlling checkout is not the recorded worktree", async () => {
  const owner = await mergedOwner();
  await using _ = owner.device;
  // A folder inside the worktree is on the recorded branch of the same repository.
  const nested = `${owner.worktree}/nested`;
  await Bun.write(`${nested}/a.txt`, "a\n", { createPath: true });
  git(owner.worktree, "add", ".");
  git(owner.worktree, "commit", "-q", "-m", "nested");
  const claim = DeviceState.claimCleanup;
  spyOn(DeviceState, "claimCleanup").mockImplementation((...args) =>
    claim(...args).map((facts) => ({
      ...facts,
      launch: { ...facts.launch, worktreePath: nested },
    })),
  );
  expect<unknown>(await cleanup(owner.request)).toMatchObject({
    tag: "Err",
    error: { reason: "cleanup_resource_mismatch" },
  });
});

test("unlanded work blocks the removal until the person instructs a forced removal", async () => {
  const owner = await mergedOwner();
  await using device = owner.device;
  await commit(owner.worktree, "late.txt", "late\n");
  await Bun.write(`${owner.worktree}/a`, "untracked\n");
  git(owner.worktree, "mv", "README.md", "moved.md");
  await Bun.write(`${device.checkout}/.git/info/exclude`, "*.log\n");
  await Bun.write(`${owner.worktree}/debug.log`, "log\n");
  const detail = `${owner.worktree} holds commits that are not in the merged head; changed or untracked moved.md, a; ignored content that preparation did not write: debug.log. ${person}`;
  expect<unknown>(await cleanup(owner.request)).toEqual(
    blocked(device, "cleanup_unlanded_work", detail),
  );
  expect<unknown>(await Bun.file(`${owner.worktree}/a`).exists()).toBe(true);
  expect<unknown>(await cleanup({ ...owner.request, personInstructed: true })).toMatchObject({
    tag: "Ok",
    value: { data: { steps: [{ step: "worktree", outcome: "removed" }] } },
  });
  expect<unknown>(await Bun.file(`${owner.worktree}/a`).exists()).toBe(false);
  expect(branches(device)).toBe("");
});

test("ignored preparation output does not block the removal", async () => {
  const owner = await mergedOwner();
  await using device = owner.device;
  await Bun.write(`${device.checkout}/.git/info/exclude`, "*.log\n");
  await Bun.write(`${owner.worktree}/debug.log`, "log\n");
  const classify = spyOn(WorktreePreparation, "classifyIgnored").mockReturnValue(
    OkAsync({ generated: ["debug.log"], unknown: [] }),
  );
  expect<unknown>(await cleanup(owner.request)).toMatchObject({
    tag: "Ok",
    value: { data: data(device, allSteps) },
  });
  expect(classify.mock.calls).toEqual([
    [
      {
        paths: device.paths,
        worktree: owner.worktree,
        controller: device.checkout,
        ignored: ["debug.log"],
      },
    ],
  ]);
});

test("an ignored entry that preparation cannot classify is unknown", async () => {
  const owner = await mergedOwner();
  await using device = owner.device;
  await Bun.write(`${device.checkout}/.git/info/exclude`, "*.log\n");
  await Bun.write(`${owner.worktree}/debug.log`, "log\n");
  spyOn(WorktreePreparation, "classifyIgnored").mockReturnValue(
    ErrAsync({ reason: "state_busy" as const, detail: "busy" }),
  );
  expect<unknown>(await cleanup(owner.request)).toEqual(
    blocked(
      device,
      "cleanup_unlanded_work",
      `${owner.worktree} holds ignored content that preparation did not write: debug.log. ${person}`,
    ),
  );
});

test("a worktree that Git cannot inspect is not proven landed", async () => {
  const owner = await mergedOwner();
  await using device = owner.device;
  const index = git(owner.worktree, "rev-parse", "--path-format=absolute", "--git-path", "index");
  await Bun.write(index, "broken");
  expect<unknown>(await cleanup({ ...owner.request, personInstructed: true })).toEqual(
    blocked(
      device,
      "cleanup_unlanded_work",
      `Git could not inspect ${owner.worktree}, so its work is not proven landed. Repeat operator cleanup after the Git failure is resolved.`,
    ),
  );
});

test("a worktree with a Herdr workspace is removed through Herdr", async () => {
  const owner = await mergedOwner();
  await using device = owner.device;
  owner.herdr.workspaces.mockReturnValue(
    OkAsync([
      { workspaceId: "w0", label: "main", checkout: device.checkout, linked: false },
      { workspaceId: "w1", label: "other", checkout: null, linked: true },
      { workspaceId: "w3", label: "other", checkout: owner.worktree, linked: true },
      { workspaceId: "w2", label: "other", checkout: `${device.root}/gone`, linked: true },
      { workspaceId: "w4", label: "main", checkout: owner.worktree, linked: false },
    ]),
  );
  expect<unknown>(await cleanup(owner.request)).toMatchObject({
    tag: "Ok",
    value: { data: data(device, allSteps) },
  });
  expect(owner.herdr.removeWorktree.mock.calls).toEqual([[{ workspaceId: "w3", force: false }]]);
  // Herdr owns that removal, so Git did not remove the worktree itself.
  expect<unknown>(await Bun.file(`${owner.worktree}/work.txt`).exists()).toBe(true);
});

test("a failed worktree removal fails the step", async () => {
  const owner = await mergedOwner();
  await using device = owner.device;
  const failure = { reason: "herdr_failed" as const, detail: "herdr exited 1" };
  owner.herdr.workspaces.mockReturnValue(ErrAsync(failure));
  expect<unknown>(await cleanup(owner.request)).toEqual({
    tag: "Err",
    error: { reason: "cleanup_failed", detail: "worktree: herdr_failed: herdr exited 1" },
  });
  owner.herdr.workspaces.mockReturnValue(
    OkAsync([{ workspaceId: "w3", label: "other", checkout: owner.worktree, linked: true }]),
  );
  owner.herdr.removeWorktree.mockReturnValue(ErrAsync(failure));
  expect<unknown>(await cleanup(owner.request)).toEqual({
    tag: "Err",
    error: { reason: "cleanup_failed", detail: "worktree: herdr_failed: herdr exited 1" },
  });
  owner.herdr.workspaces.mockReturnValue(OkAsync([]));
  git(device.checkout, "worktree", "lock", owner.worktree);
  const result = await cleanup(owner.request);
  expect<unknown>(result).toMatchObject({
    tag: "Err",
    error: {
      reason: "cleanup_failed",
      detail: expect.stringMatching(
        /^worktree: git_failed: git worktree remove failed: \S.*\S$/s,
      ) as unknown,
    },
  });
  expect<unknown>(recorded(device)).toMatchObject({ step: "worktree", state: "failed" });
  expect(branches(device)).toContain("task/other");
});

test("a state write that fails stops the cleanup", async () => {
  const owner = await mergedOwner();
  await using device = owner.device;
  const failure = { reason: "state_busy" as const, detail: "locked" };
  const advance = spyOn(DeviceState, "advanceCleanup").mockReturnValue(Err(failure));
  expect<unknown>(await cleanup(owner.request)).toMatchObject({ tag: "Err", error: failure });
  expect(advance).toHaveBeenCalledTimes(1);
  device.answer(() => failed("Server Error", 500));
  expect<unknown>(await cleanup(owner.request)).toMatchObject({ tag: "Err", error: failure });
});

/** Answers chosen Git commands with no answer, as a killed Git does, and runs the rest. */
function silentGit(command: string) {
  const run = ToolInvocation.run;
  spyOn(ToolInvocation, "run").mockImplementation(async (request) =>
    request.tool === "git" && request.args[2] === command
      ? { status: "no-answer" as const, detail: "git ended on SIGKILL" }
      : run(request),
  );
}

test("a Git command without an answer never proves the worktree landed or removed", async () => {
  for (const [command, reason] of [
    ["status", "cleanup_unlanded_work"],
    ["symbolic-ref", "cleanup_resource_mismatch"],
    ["merge-base", "cleanup_unlanded_work"],
  ] as const) {
    const owner = await mergedOwner();
    await using device = owner.device;
    silentGit(command);
    expect<unknown>(await cleanup(owner.request)).toMatchObject({ tag: "Err", error: { reason } });
    expect(recorded(device)).toMatchObject({ step: "worktree", state: "blocked", reason });
    mock.restore();
  }
  const owner = await mergedOwner();
  await using device = owner.device;
  silentGit("worktree");
  expect<unknown>(await cleanup(owner.request)).toEqual({
    tag: "Err",
    error: {
      reason: "cleanup_failed",
      detail: "worktree: git_failed: git worktree remove failed: Git did not answer.",
    },
  });
  expect(recorded(device)).toMatchObject({ step: "worktree", state: "failed" });
});

test("a branch read that fails after the deletion fails the step", async () => {
  const owner = await mergedOwner();
  await using device = owner.device;
  device.answer((args) => {
    if (requestKind(args) === "delete_branch") return succeeded(null, 204);
    return device.calls.length > 1
      ? failed("Server Error", 500)
      : succeeded({ object: { sha: owner.head } });
  });
  expect<unknown>(await cleanup(owner.request)).toEqual({
    tag: "Err",
    error: {
      reason: "cleanup_failed",
      detail: "remote_branch: github_failed: github_refused: Server Error",
    },
  });
});

test("each finished step records the next step as pending before it runs", async () => {
  const owner = await mergedOwner();
  await using device = owner.device;
  const seen: (string | null | undefined)[][] = [];
  owner.herdr.pane.mockImplementation(() => {
    const read = DeviceState.readSources(device.paths, repository, device.sourceId);
    const row = read.tag === "Ok" ? read.value[0]?.cleanups[0] : undefined;
    seen.push([row?.step, row?.state]);
    return OkAsync({ tabId: "t1", workspaceId: "w1" });
  });
  expect<unknown>(await cleanup(owner.request)).toMatchObject({ tag: "Ok" });
  expect(seen).toEqual([["pane", "pending"]]);
});

test("a Git command without an answer keeps the local branch", async () => {
  for (const command of ["update-ref", "merge-base", "absent update-ref"]) {
    const owner = await mergedOwner();
    await using device = owner.device;
    if (command !== "update-ref") await rm(owner.worktree, { recursive: true, force: true });
    silentGit(command.replace("absent ", ""));
    expect<unknown>(await cleanup(owner.request)).toMatchObject({
      tag: "Ok",
      value: {
        data: {
          steps: [
            {},
            {},
            {
              step: "worktree",
              outcome:
                command === "update-ref"
                  ? "removed, local branch kept"
                  : "absent, local branch kept",
            },
          ],
        },
      },
    });
    expect(branches(device)).toContain("task/other");
    mock.restore();
  }
});

test("each recorded result releases the cleanup claim and the lease", async () => {
  const owner = await mergedOwner();
  await using device = owner.device;
  const release = mock(() => undefined);
  const hold = spyOn(DeviceState, "holdCleanup").mockReturnValue(release);
  function claim() {
    const read = DeviceState.readSources(device.paths, repository, device.sourceId);
    const row = read.tag === "Ok" ? read.value[0]?.cleanups[0] : undefined;
    return [row?.state, row?.ownerPid];
  }
  owner.herdr.pane.mockReturnValue(
    ErrAsync({ reason: "herdr_failed" as const, detail: "herdr exited 1" }),
  );
  expect<unknown>(await cleanup(owner.request)).toMatchObject({ tag: "Err" });
  expect(claim()).toEqual(["failed", null]);
  expect(hold.mock.calls).toEqual([[device.paths, device.sourceId, "other"]]);
  expect(release).toHaveBeenCalledTimes(1);
  owner.herdr.pane.mockReturnValue(OkAsync({ tabId: "t1", workspaceId: "w1" }));
  expect<unknown>(await cleanup(owner.request)).toMatchObject({ tag: "Ok" });
  expect(claim()).toEqual(["done", null]);
  expect(release).toHaveBeenCalledTimes(2);
});
