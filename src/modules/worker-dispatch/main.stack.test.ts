import { afterAll, afterEach, expect, mock, setSystemTime, test } from "bun:test";
import { OperatorHome } from "../operator-home/main.ts";
import { dispatchDevice, git, removeDevices } from "./dispatch-fixture.ts";
import { WorkerDispatch } from "./main.ts";

afterEach(() => {
  mock.restore();
  setSystemTime();
});
afterAll(removeDevices);

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
  expect(brief).toContain(
    "Your branch starts on `task/parent`, the branch of PR #5 of assignment `parent`.",
  );
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
