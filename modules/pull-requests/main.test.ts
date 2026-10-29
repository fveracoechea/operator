import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { DeviceState } from "../device-state/main.ts";
import {
  associationBody,
  commit,
  failed,
  git,
  parentBody,
  prDevice,
  pullRequestBody,
  repository,
  requestKind,
  succeeded,
} from "./device-fixture.ts";
import { PullRequests } from "./main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { Err, OkAsync } from "unthrown";
import { stacked } from "./relay.ts";

afterEach(() => {
  mock.restore();
});

type Device = Awaited<ReturnType<typeof prDevice>>;
const parent = { assignment: "parent", number: 6, branch: "task/parent" };
function url(number: number) {
  return `https://github.com/${repository}/pull/${number}`;
}

function summary(device: Device, assignment: string, number: number) {
  return {
    sourceId: device.sourceId,
    assignment,
    branch: `task/${assignment}`,
    number,
    url: url(number),
  };
}

const allMet = {
  approved: true,
  checksPassing: true,
  threadsResolved: true,
  defaultBase: true,
  stackRelayed: true,
};

test("the owner associates its one open PR, and a repeat changes nothing", async () => {
  await using device = await prDevice();
  const { worktree } = device.start("other");
  device.answer(() => succeeded(associationBody([{ number: 7, base: "main" }])));
  const input = { paths: device.paths, cwd: worktree };
  const data = { ...summary(device, "other", 7), state: "pr-open", base: "main", stack: null };
  expect<unknown>(await PullRequests.associate(input)).toEqual({
    tag: "Ok",
    value: { reason: "pr_associated", data },
  });
  expect(device.pullRequestRow("other")).toMatchObject({ number: 7, url: url(7), relay: null });
  expect<unknown>(
    DeviceState.readReviewRequest(device.paths, { repository, number: 7 }),
  ).toMatchObject({ tag: "Ok", value: { request: null } });
  expect<unknown>(await PullRequests.associate(input)).toEqual({
    tag: "Ok",
    value: { reason: "pr_unchanged", data },
  });
});

test("an enabled assignment reviewer is queued with the association", async () => {
  await using device = await prDevice();
  await Bun.write(device.paths.config, JSON.stringify({ review: { assignments: true } }), {
    createPath: true,
  });
  const { worktree } = device.start("other");
  device.answer(() => succeeded(associationBody([{ number: 7, base: "main" }])));
  expect<unknown>(
    await PullRequests.associate({ paths: device.paths, cwd: worktree }),
  ).toMatchObject({ tag: "Ok", value: { reason: "pr_associated" } });
  expect<unknown>(
    DeviceState.readReviewRequest(device.paths, { repository, number: 7 }),
  ).toMatchObject({ tag: "Ok", value: { request: { assignment: "other", number: 7 } } });
});

test("no open PR or more than one open PR is not associated", async () => {
  await using device = await prDevice();
  const { worktree } = device.start("other");
  const detail = `Open exactly one PR from task/other in ${repository}, then repeat. Nothing was changed.`;
  for (const [prs, reason] of [
    [[], "pr_not_found"],
    [
      [
        { number: 7, base: "main" },
        { number: 8, base: "main" },
      ],
      "pr_ambiguous",
    ],
  ] as const) {
    device.answer(() => succeeded(associationBody([...prs])));
    expect<unknown>(await PullRequests.associate({ paths: device.paths, cwd: worktree })).toEqual({
      tag: "Err",
      error: { reason, detail },
    });
  }
  expect(device.pullRequestRow("other")).toBeNull();
});

test("an association outside a recorded worktree reads nothing", async () => {
  await using device = await prDevice();
  device.start("other");
  expect<unknown>(
    await PullRequests.associate({ paths: device.paths, cwd: device.checkout }),
  ).toMatchObject({ tag: "Err", error: { reason: "pr_worktree_unrecorded" } });
  expect(device.calls).toEqual([]);
});

/** Records PR #6 of `parent` and PR #8 of `other`, then starts `child`, which depends on parent. */
function stack(device: Device) {
  const parentStart = device.start("parent");
  device.associate(parentStart.launchId, 6, "task/parent");
  const second = device.start("second");
  device.associate(second.launchId, 9, "task/second");
  const other = device.start("other");
  device.associate(other.launchId, 8, "task/other");
  return { parent: parentStart, child: device.start("child") };
}

test("a PR on a dependency's PR branch is recorded as stacked", async () => {
  await using device = await prDevice();
  const { child } = stack(device);
  device.answer(() =>
    succeeded(associationBody([{ number: 7, base: "task/parent", head: "task/child" }])),
  );
  expect<unknown>(
    await PullRequests.associate({ paths: device.paths, cwd: child.worktree }),
  ).toEqual({
    tag: "Ok",
    value: {
      reason: "pr_associated",
      data: {
        ...summary(device, "child", 7),
        state: "pr-open",
        base: "task/parent",
        stack: { parent, relay: "stacked", blocker: null },
      },
    },
  });
  expect(JSON.parse(device.pullRequestRow("child")?.relay ?? "null")).toEqual(stacked(parent));
});

test("a PR base that is neither the default branch nor a dependency's branch is refused", async () => {
  await using device = await prDevice();
  const { child, parent: parentStart } = stack(device);
  device.answer(() =>
    succeeded(associationBody([{ number: 7, base: "task/other", head: "task/child" }])),
  );
  expect<unknown>(
    await PullRequests.associate({ paths: device.paths, cwd: child.worktree }),
  ).toEqual({
    tag: "Err",
    error: {
      reason: "pr_base_invalid",
      detail:
        "The PR targets task/other. Target the default branch or the branch of a dependency's PR: task/parent, task/second. Nothing was changed.",
    },
  });
  // The parent has no dependencies, so no branch but the default one is a valid base.
  device.answer(() =>
    succeeded(associationBody([{ number: 6, base: "task/other", head: "task/parent" }])),
  );
  expect<unknown>(
    await PullRequests.associate({ paths: device.paths, cwd: parentStart.worktree }),
  ).toEqual({
    tag: "Err",
    error: {
      reason: "pr_base_invalid",
      detail:
        "The PR targets task/other. Target the default branch or the branch of a dependency's PR: none. Nothing was changed.",
    },
  });
  expect(device.pullRequestRow("child")).toBeNull();
});

/** A running owner of `other` with PR #7 recorded. */
function waiting(device: Device, relay: string | null = null) {
  const started = device.start("other");
  device.associate(started.launchId, 7, "task/other", relay);
  return { ...started, input: { paths: device.paths, cwd: started.worktree, timeoutSeconds: 0 } };
}

test("a wait reports an eligible head once and records each result", async () => {
  await using device = await prDevice();
  const { input } = waiting(device);
  device.answer(() => succeeded(pullRequestBody()));
  const data = { ...summary(device, "other", 7), head: "h1", mergeConditions: allMet };
  expect<unknown>(await PullRequests.wait(input)).toEqual({
    tag: "Ok",
    value: {
      reason: "pr_events_observed",
      data: { ...data, events: [{ kind: "merge_eligible", head: "h1" }] },
    },
  });
  expect(device.pullRequestRow("other")).toMatchObject({
    waitState: "reported",
    waitOwnerPid: null,
  });
  expect(JSON.parse(device.pullRequestRow("other")?.progress ?? "null")).toEqual({
    seen: [],
    failures: [],
    eligibleHead: "h1",
  });
  expect<unknown>(await PullRequests.wait(input)).toEqual({
    tag: "Ok",
    value: { reason: "pr_wait_timed_out", data: { ...data, events: [] } },
  });
  expect(device.pullRequestRow("other")).toMatchObject({ waitState: "timed_out" });
  expect(device.calls.map(requestKind)).toEqual(["pull_request", "pull_request"]);
});

test("a merged or closed PR ends the wait", async () => {
  await using device = await prDevice();
  const { input } = waiting(device);
  for (const [state, kind] of [
    ["MERGED", "pr_merged"],
    ["CLOSED", "pr_closed"],
  ] as const) {
    device.answer(() => succeeded(pullRequestBody({ state, approved: false })));
    expect<unknown>(await PullRequests.wait(input)).toMatchObject({
      tag: "Ok",
      value: { reason: "pr_not_open", data: { events: [{ kind }] } },
    });
    expect(device.pullRequestRow("other")).toMatchObject({ waitState: "not_open" });
  }
});

test("a wait polls again until an event arrives", async () => {
  await using device = await prDevice();
  const { input } = waiting(device);
  const release = mock(() => undefined);
  const hold = spyOn(DeviceState, "holdPullRequestWait").mockReturnValue(release);
  const during: (string | number | null)[][] = [];
  device.answer(() => {
    // The running wait holds the record as waiting, also after an observation without events.
    const row = device.pullRequestRow("other");
    during.push([row?.waitState ?? null, row?.waitOwnerPid ?? null]);
    return succeeded(
      pullRequestBody(
        device.calls.length > 1
          ? { approved: false, comments: [{ id: "c1", body: "Fix.", author: "reviewer" }] }
          : { approved: false },
      ),
    );
  });
  const started = Date.now();
  expect<unknown>(await PullRequests.wait({ ...input, timeoutSeconds: 0.3 })).toMatchObject({
    tag: "Ok",
    value: {
      reason: "pr_events_observed",
      data: { events: [{ kind: "feedback", items: [{ id: "c1" }] }] },
    },
  });
  expect(device.calls.length).toBe(2);
  // The second read waits for the poll interval, which the deadline shortens.
  // The upper bound stays far below the 30-second interval, so a loaded host passes too.
  expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  expect(Date.now() - started).toBeLessThan(20000);
  expect(during).toEqual([
    ["waiting", process.pid],
    ["waiting", process.pid],
  ]);
  expect(hold.mock.calls).toEqual([[device.paths, device.sourceId, "other"]]);
  expect(release).toHaveBeenCalledTimes(1);
});

test("a wait without a recorded PR records nothing", async () => {
  await using device = await prDevice();
  const { worktree } = device.start("other");
  expect<unknown>(
    await PullRequests.wait({ paths: device.paths, cwd: worktree, timeoutSeconds: 0 }),
  ).toEqual({
    tag: "Err",
    error: {
      reason: "pr_not_associated",
      detail: "Run operator pr associate after you open the PR. Nothing was changed.",
    },
  });
  expect(device.calls).toEqual([]);
});

test("a stacked PR reads its open parent and is not eligible before its relay", async () => {
  await using device = await prDevice();
  const { input } = waiting(device, JSON.stringify(stacked(parent)));
  device.answer((args) =>
    succeeded(
      requestKind(args) === "parent" ? parentBody("OPEN", "main", "p1") : pullRequestBody(),
    ),
  );
  expect<unknown>(await PullRequests.wait(input)).toMatchObject({
    tag: "Ok",
    value: {
      reason: "pr_wait_timed_out",
      data: { mergeConditions: { ...allMet, stackRelayed: false }, events: [] },
    },
  });
  expect(device.calls.map(requestKind)).toEqual(["pull_request", "parent"]);
  expect(JSON.parse(device.pullRequestRow("other")?.relay ?? "null")).toEqual(stacked(parent));
});

test("a relayed PR reads no parent and can be eligible", async () => {
  await using device = await prDevice();
  const { input } = waiting(device, JSON.stringify({ ...stacked(parent), state: "relayed" }));
  device.answer(() => succeeded(pullRequestBody()));
  expect<unknown>(await PullRequests.wait(input)).toMatchObject({
    tag: "Ok",
    value: { reason: "pr_events_observed", data: { mergeConditions: allMet } },
  });
  expect(device.calls.map(requestKind)).toEqual(["pull_request"]);
});

test("a closed parent blocks the relay for the person", async () => {
  await using device = await prDevice();
  const { input } = waiting(device, JSON.stringify(stacked(parent)));
  device.answer((args) =>
    succeeded(
      requestKind(args) === "parent"
        ? parentBody("CLOSED", "main", "p1")
        : pullRequestBody({ base: "task/parent" }),
    ),
  );
  const blocker = {
    reason: "relay_parent_closed",
    detail:
      "Parent PR #6 was closed without a merge. Your PR still targets task/parent. Ask your SuperAgent.",
  };
  expect<unknown>(await PullRequests.wait(input)).toEqual({ tag: "Err", error: blocker });
  expect(device.pullRequestRow("other")).toMatchObject({ waitState: "reported" });
  expect(JSON.parse(device.pullRequestRow("other")?.relay ?? "null")).toEqual({
    ...stacked(parent),
    state: "blocked",
    blocker,
  });
});

test("a live relay claim of another process leaves this wait to observe only", async () => {
  await using device = await prDevice();
  const held = { ...stacked(parent), ownerPid: process.ppid, leaseAt: new Date().toISOString() };
  const { input } = waiting(device, JSON.stringify(held));
  device.answer((args) =>
    succeeded(
      requestKind(args) === "parent"
        ? parentBody("CLOSED", "main", "p1")
        : pullRequestBody({ base: "task/parent" }),
    ),
  );
  expect<unknown>(await PullRequests.wait(input)).toMatchObject({
    tag: "Ok",
    value: { reason: "pr_wait_timed_out" },
  });
  expect(JSON.parse(device.pullRequestRow("other")?.relay ?? "null")).toEqual(held);
});

/**
 * A pushed parent and child in a local remote, with the parent squash-merged into main there.
 * The child PR #7 still targets the parent's branch.
 */
async function relayScenario(device: Device) {
  const remote = `${device.root}/remote.git`;
  git(device.root, "init", "-q", "--bare", "-b", "main", remote);
  git(device.checkout, "remote", "add", "local", remote);
  git(device.checkout, "push", "-q", "local", "main");
  const parentStart = device.start("parent");
  const parentHead = await commit(parentStart.worktree, "parent.txt", "parent\n");
  git(parentStart.worktree, "push", "-q", "-u", "local", "task/parent");
  device.associate(parentStart.launchId, 6, "task/parent");
  const child = device.start("child");
  git(child.worktree, "reset", "-q", "--hard", "task/parent");
  const childHead = await commit(child.worktree, "child.txt", "child\n");
  git(child.worktree, "push", "-q", "-u", "local", "task/child");
  device.associate(child.launchId, 7, "task/child", JSON.stringify(stacked(parent)));
  git(device.checkout, "merge", "-q", "--squash", "task/parent");
  git(device.checkout, "commit", "-q", "-m", "parent (#6)");
  git(device.checkout, "push", "-q", "local", "main");
  const main = git(device.checkout, "rev-parse", "HEAD");
  return {
    remote,
    child,
    childHead,
    parentHead,
    main,
    input: { paths: device.paths, cwd: child.worktree, timeoutSeconds: 0 },
  };
}

function relayAnswers(
  device: Device,
  scenario: Awaited<ReturnType<typeof relayScenario>>,
  retarget: () => ReturnType<typeof succeeded> | Promise<ReturnType<typeof succeeded>> = () =>
    succeeded({ base: { ref: "main" } }),
) {
  device.answer((args) => {
    const kind = requestKind(args);
    if (kind === "parent") return succeeded(parentBody("MERGED", "main", scenario.parentHead));
    if (kind === "retarget") return retarget();
    return succeeded(pullRequestBody({ head: scenario.childHead, base: "task/parent" }));
  });
}

test("a merged parent relays the child onto the default branch", async () => {
  await using device = await prDevice();
  const scenario = await relayScenario(device);
  relayAnswers(device, scenario);
  const result = await PullRequests.wait(scenario.input);
  const head = git(scenario.child.worktree, "rev-parse", "HEAD");
  expect(head).not.toBe(scenario.childHead);
  expect(git(scenario.child.worktree, "rev-parse", "HEAD~1")).toBe(scenario.main);
  expect(git(device.root, "--git-dir", scenario.remote, "rev-parse", "task/child")).toBe(head);
  expect<unknown>(result).toEqual({
    tag: "Ok",
    value: {
      reason: "pr_events_observed",
      data: {
        ...summary(device, "child", 7),
        head,
        mergeConditions: {
          approved: true,
          checksPassing: false,
          threadsResolved: true,
          defaultBase: true,
          stackRelayed: false,
        },
        events: [{ kind: "parent_relayed", parent, base: "main", head }],
      },
    },
  });
  expect(device.calls.map(requestKind)).toEqual(["pull_request", "parent", "retarget"]);
  expect(device.calls[2]).toEqual([
    "-X",
    "PATCH",
    `repos/${repository}/pulls/7`,
    "-f",
    "base=main",
  ]);
  expect(device.pullRequestRow("child")).toMatchObject({ waitState: "reported" });
  expect(JSON.parse(device.pullRequestRow("child")?.relay ?? "null")).toEqual({
    ...stacked(parent),
    state: "relayed",
    rebasedHead: head,
  });
});

test("a relay that Git or GitHub stops is recorded as blocked", async () => {
  await using device = await prDevice();
  const scenario = await relayScenario(device);
  relayAnswers(device, scenario, () => failed("Base is protected"));
  const detail =
    "The branch is pushed, but GitHub did not change the PR base to main: github_refused: Base is protected Wait again to retry.";
  expect<unknown>(await PullRequests.wait(scenario.input)).toEqual({
    tag: "Err",
    error: { reason: "relay_retarget_failed", detail },
  });
  const relay = JSON.parse(device.pullRequestRow("child")?.relay ?? "null") as unknown;
  expect(relay).toMatchObject({
    state: "blocked",
    blocker: { reason: "relay_retarget_failed", detail },
    ownerPid: null,
    leaseAt: null,
  });
  // A blocked relay runs again on the next wait, without a second rebase.
  relayAnswers(device, scenario, () => Promise.reject(new Error("boom")));
  expect<unknown>(await PullRequests.wait(scenario.input)).toEqual({
    tag: "Err",
    error: {
      reason: "relay_retarget_failed",
      detail:
        "The branch is pushed, but GitHub did not change the PR base to main: The base change stopped with a defect. Wait again to retry.",
    },
  });
});

test("a relay that loses its claim reports no relay", async () => {
  await using device = await prDevice();
  const scenario = await relayScenario(device);
  relayAnswers(device, scenario, () => {
    // Another process takes the claim while the base change runs.
    DeviceState.recordPullRequestWait(device.paths, scenario.child.launchId, (row) => ({
      progress: row.progress,
      waitState: row.waitState,
      relay: JSON.stringify({ ...stacked(parent), ownerPid: process.ppid, leaseAt: null }),
    }));
    return succeeded({ base: { ref: "main" } });
  });
  expect<unknown>(await PullRequests.wait(scenario.input)).toMatchObject({
    tag: "Ok",
    value: { reason: "pr_wait_timed_out", data: { events: [] } },
  });
});

test("a missing source or plan row permits no stack parent", async () => {
  await using device = await prDevice();
  const { child } = stack(device);
  device.answer(() =>
    succeeded(associationBody([{ number: 7, base: "task/parent", head: "task/child" }])),
  );
  const show = WorkSources.show;
  const refused = {
    tag: "Err",
    error: {
      reason: "pr_base_invalid",
      detail:
        "The PR targets task/parent. Target the default branch or the branch of a dependency's PR: none. Nothing was changed.",
    },
  };
  spyOn(WorkSources, "show").mockReturnValue(OkAsync(undefined));
  expect<unknown>(
    await PullRequests.associate({ paths: device.paths, cwd: child.worktree }),
  ).toEqual(refused);
  spyOn(WorkSources, "show").mockImplementation((input) =>
    show(input).map((source) =>
      source === undefined ? source : { ...source, plan: { ...source.plan, assignments: [] } },
    ),
  );
  expect<unknown>(
    await PullRequests.associate({ paths: device.paths, cwd: child.worktree }),
  ).toEqual(refused);
});

/** Answers a stacked wait with a closed parent, after `change` alters the recorded relay. */
function closedParent(device: Device, launchId: string, relay: () => string | null) {
  device.answer((args) => {
    if (requestKind(args) !== "parent") return succeeded(pullRequestBody({ base: "task/parent" }));
    // Another wait finishes or clears the relay between this wait's reads and its claim.
    DeviceState.recordPullRequestWait(device.paths, launchId, (row) => ({
      progress: row.progress,
      waitState: row.waitState,
      relay: relay(),
    }));
    return succeeded(parentBody("CLOSED", "main", "p1"));
  });
}

test("a relay that another wait finished or cleared is not claimed", async () => {
  for (const relay of [JSON.stringify({ ...stacked(parent), state: "relayed" }), null]) {
    await using device = await prDevice();
    const { launchId, input } = waiting(device, JSON.stringify(stacked(parent)));
    closedParent(device, launchId, () => relay);
    expect<unknown>(await PullRequests.wait(input)).toMatchObject({
      tag: "Ok",
      value: { reason: "pr_wait_timed_out" },
    });
    expect(device.pullRequestRow("other")?.relay).toBe(relay);
  }
});

test("a relay that loses its claim before the rebase stops without a branch change", async () => {
  await using device = await prDevice();
  const scenario = await relayScenario(device);
  relayAnswers(device, scenario);
  const release = mock(() => undefined);
  const hold = spyOn(DeviceState, "holdPullRequestRelay").mockImplementation(() => {
    DeviceState.recordPullRequestWait(device.paths, scenario.child.launchId, (row) => ({
      progress: row.progress,
      waitState: row.waitState,
      relay: JSON.stringify({ ...stacked(parent), ownerPid: process.ppid, leaseAt: null }),
    }));
    return release;
  });
  expect<unknown>(await PullRequests.wait(scenario.input)).toEqual({
    tag: "Err",
    error: {
      reason: "relay_claim_lost",
      detail: "Another process took over the relay. Wait again.",
    },
  });
  expect(hold.mock.calls).toEqual([[device.paths, device.sourceId, "child"]]);
  expect(release).toHaveBeenCalledTimes(1);
  expect(git(device.root, "--git-dir", scenario.remote, "rev-parse", "task/child")).toBe(
    scenario.childHead,
  );
  expect(device.calls.map(requestKind)).toEqual(["pull_request", "parent"]);
});

test("a relay whose record is cleared or cannot be written stops as a lost claim", async () => {
  for (const change of ["cleared", "write failed"]) {
    await using device = await prDevice();
    const scenario = await relayScenario(device);
    relayAnswers(device, scenario);
    const record = DeviceState.recordPullRequestWait;
    let writes = 0;
    spyOn(DeviceState, "recordPullRequestWait").mockImplementation((paths, launchId, decide) => {
      writes++;
      // The third write records the rebase, after the start and the claim.
      if (writes === 3 && change === "write failed")
        return Err({ reason: "state_busy" as const, detail: "busy" });
      return record(paths, launchId, decide);
    });
    spyOn(DeviceState, "holdPullRequestRelay").mockImplementation(() => {
      if (change === "cleared")
        record(device.paths, scenario.child.launchId, (row) => ({
          progress: row.progress,
          waitState: row.waitState,
          relay: null,
        }));
      return () => undefined;
    });
    expect<unknown>(await PullRequests.wait(scenario.input)).toEqual({
      tag: "Err",
      error: {
        reason: "relay_claim_lost",
        detail: "Another process took over the relay. Wait again.",
      },
    });
    expect(git(device.root, "--git-dir", scenario.remote, "rev-parse", "task/child")).toBe(
      scenario.childHead,
    );
    mock.restore();
  }
});

test("the interface runs the owner's merge and the cleanup", async () => {
  await using device = await prDevice();
  const { worktree } = device.start("other");
  expect<unknown>(await PullRequests.merge({ paths: device.paths, cwd: worktree })).toMatchObject({
    tag: "Err",
    error: { reason: "pr_not_associated" },
  });
  expect<unknown>(
    await PullRequests.cleanup({
      paths: device.paths,
      cwd: device.checkout,
      sourceId: device.sourceId,
      assignment: "other",
      personInstructed: false,
    }),
  ).toMatchObject({ tag: "Err", error: { reason: "cleanup_not_found" } });
});
