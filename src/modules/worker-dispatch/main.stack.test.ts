import { afterAll, afterEach, expect, mock, setSystemTime, test } from "bun:test";
import { OperatorHome } from "../operator-home/main.ts";
import { DeviceState } from "../device-state/main.ts";
import { dispatchDevice, git, removeDevices } from "./dispatch-fixture.ts";
import { WorkerDispatch } from "./main.ts";

afterEach(() => {
  mock.restore();
  setSystemTime();
});
afterAll(removeDevices);

test.each(["stacked", "blocked", "relayed", null])(
  "a replacement brief selects the recorded %s relay base, not current plan eligibility",
  async (state) => {
    await using device = await dispatchDevice();
    expect(await WorkerDispatch.dispatch(device.request("parent"))).toMatchObject({ tag: "Ok" });
    const [parent] = await device.launches("parent");
    device.associate(parent?.id ?? "", 5, "task/parent");
    // impl has no planned dependencies. Only its recorded PR relay can supply this base.
    expect(await WorkerDispatch.dispatch(device.request("impl"))).toMatchObject({ tag: "Ok" });
    const [owner] = await device.launches("impl");
    if (owner === undefined) expect.unreachable("The PR owner is missing.");
    expect(
      DeviceState.associatePullRequest(device.paths, owner.id, {
        number: 7,
        url: "https://github.com/example/one/pull/7",
        branch: "task/impl",
        relay:
          state === null
            ? null
            : JSON.stringify({
                parent: { assignment: "parent", number: 5, branch: "task/parent" },
                state,
                blocker:
                  state === "blocked"
                    ? { reason: "relay_conflict", detail: "Resolve the conflict." }
                    : null,
              }),
      }).tag,
    ).toBe("Ok");
    if (state === "stacked" || state === "blocked") device.merged(parent?.id ?? "", 5);
    device.exited("p2");
    device.reopening();
    const replacement = await WorkerDispatch.dispatch(device.request("impl"));
    expect(replacement.tag).toBe("Ok");
    if (replacement.tag !== "Ok") expect.unreachable("The PR replacement was refused.");
    const brief = await Bun.file(replacement.value.brief).text();
    expect(brief).toContain("PR #7: https://github.com/example/one/pull/7");
    if (state === "stacked" || state === "blocked") {
      expect(brief).toContain("Base: `task/parent`");
      expect(brief).toContain("Parent: `parent`, PR #5, branch `task/parent`.");
    } else {
      expect(brief).toContain("Base: `default branch`");
      expect(brief).not.toContain("## Stack");
    }
    expect(device.herdr.createWorktree).toHaveBeenCalledTimes(2);
  },
);

test("a PR child starts at its one open parent's pushed head and targets its branch", async () => {
  await using device = await dispatchDevice();
  const { checkout } = device;
  for (const key of ["parent", "impl"]) {
    await WorkerDispatch.dispatch(device.request(key));
    const [launch] = await device.launches(key);
    device.associate(launch?.id ?? "", key === "parent" ? 5 : 6, `task/${key}`);
  }
  const parent = `${device.root}/worktrees/pr-one-6-parent`;
  await Bun.write(`${parent}/a.ts`, "a\n");
  git(parent, "add", "a.ts");
  git(parent, "commit", "-q", "-m", "parent work");
  git(parent, "push", "-q", "-u", "local", "task/parent");
  const pushed = git(parent, "rev-parse", "HEAD");
  expect(await WorkerDispatch.dispatch(device.request("child"))).toMatchObject({ tag: "Ok" });
  expect(device.herdr.createWorktree).toHaveBeenLastCalledWith({
    workspaceId: "w1",
    branch: "task/child",
    label: "pr-one-5-child",
    base: pushed,
  });
  const brief = await Bun.file(
    OperatorHome.assignmentFiles(device.paths, {
      repository: "example/one",
      sourceId: device.sourceId,
      assignment: "child",
    }).brief,
  ).text();
  expect(brief).toContain("Parent: `parent`, PR #5, branch `task/parent`.");
  // A report that depends on the PR does not stack on it.
  expect(await WorkerDispatch.dispatch(device.request("notes"))).toMatchObject({ tag: "Ok" });
  expect(device.herdr.createWorktree).toHaveBeenLastCalledWith({
    workspaceId: "w1",
    branch: "task/notes",
    label: "report-one-5-notes",
    base: undefined,
  });
  expect(git(checkout, "rev-parse", "task/notes")).toBe(git(checkout, "rev-parse", "main"));
  // A replacement reopens its worktree, so it needs no pushed parent any more.
  device.exited("p2");
  git(parent, "push", "-q", "local", "--delete", "task/parent");
  device.reopening();
  expect(await WorkerDispatch.dispatch(device.request("child"))).toMatchObject({
    tag: "Ok",
    value: { branch: "task/child", worktreePath: `${device.root}/worktrees/pr-one-5-child` },
  });
});

test("a child of a merged parent starts on the default branch", async () => {
  await using device = await dispatchDevice();
  await WorkerDispatch.dispatch(device.request("parent"));
  const [launch] = await device.launches("parent");
  device.associate(launch?.id ?? "", 5, "task/parent");
  device.merged(launch?.id ?? "", 5);
  expect(await WorkerDispatch.dispatch(device.request("child"))).toMatchObject({ tag: "Ok" });
  expect(device.herdr.createWorktree).toHaveBeenLastCalledWith({
    workspaceId: "w1",
    branch: "task/child",
    label: "pr-one-5-child",
    base: undefined,
  });
});

test("a parent branch that was never pushed refuses the child before any record", async () => {
  await using device = await dispatchDevice();
  await WorkerDispatch.dispatch(device.request("parent"));
  const [launch] = await device.launches("parent");
  device.associate(launch?.id ?? "", 5, "task/parent");
  expect(await WorkerDispatch.dispatch(device.request("child"))).toMatchObject({
    tag: "Err",
    error: { reason: "parent_branch_unavailable" },
  });
  expect(await device.launches("child")).toEqual([]);
});
