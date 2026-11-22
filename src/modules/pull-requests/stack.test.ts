import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { OkAsync } from "unthrown";
import { WorkerDispatch } from "../worker-dispatch/main.ts";
import { DeviceState } from "../device-state/main.ts";
import { prDevice, associationBody, succeeded, git, commit } from "./device-fixture.ts";
import { stack } from "./stack.ts";

afterEach(() => mock.restore());

async function stackScenario(device: Awaited<ReturnType<typeof prDevice>>) {
  const remote = `${device.root}/stack-remote.git`;
  git(device.root, "init", "--bare", "-q", remote);
  git(device.checkout, "remote", "set-url", "origin", remote);
  git(device.checkout, "remote", "add", "github", "https://github.com/example/one.git");
  const parent = device.start("parent");
  await commit(parent.worktree, "parent", "parent\n");
  git(parent.worktree, "push", "-qu", "origin", "task/parent");
  device.associate(parent.launchId, 6, "task/parent");
  const second = device.start("second");
  git(second.worktree, "push", "-qu", "origin", "task/second");
  device.associate(second.launchId, 9, "task/second");
  const child = device.start("child");
  const cut = git(parent.worktree, "rev-parse", "HEAD");
  git(child.worktree, "merge", "--ff-only", cut);
  await commit(child.worktree, "child", "child\n");
  git(child.worktree, "push", "-qu", "origin", "task/child");
  device.associate(child.launchId, 8, "task/child");
  device.answer((args) => {
    const branch = args.find((arg) => arg.startsWith("branch="))?.slice(7);
    if (branch !== undefined) {
      const number = branch === "task/child" ? 8 : branch === "task/parent" ? 6 : 9;
      const body = associationBody([
        { number, base: number === 8 ? "task/parent" : "main", head: branch },
      ]);
      const node = body.data.repository.pullRequests.nodes[0];
      if (node !== undefined) {
        node.headRefOid = git(device.root, "--git-dir", remote, "rev-parse", branch);
        node.isDraft = true;
      }
      return succeeded(body);
    }
    const number = Number(args.find((arg) => arg.startsWith("number="))?.slice(7));
    const name = number === 6 ? "task/parent" : "task/second";
    return succeeded({
      data: {
        repository: {
          pullRequest: {
            state: "OPEN",
            baseRefName: "main",
            headRefOid: git(device.root, "--git-dir", remote, "rev-parse", name),
            headRefName: name,
            headRepository: { nameWithOwner: "example/one" },
          },
        },
      },
    });
  });
  spyOn(WorkerDispatch, "refreshStackBrief").mockReturnValue(OkAsync("/brief"));
  return { parent, child, cut, input: { paths: device.paths, cwd: child.worktree } };
}

test("direct stack refresh persists provenance, retains the old head, and replays only child changes", async () => {
  await using device = await prDevice();
  const scenario = await stackScenario(device);
  const original = git(scenario.child.worktree, "rev-parse", "HEAD");
  await commit(scenario.parent.worktree, "parent-new", "new prerequisite\n");
  git(scenario.parent.worktree, "push", "-q");
  const target = git(scenario.parent.worktree, "rev-parse", "HEAD");
  const preview = await stack({ ...scenario.input, action: "plan" });
  expect(preview).toMatchObject({ tag: "Ok" });
  if (preview.tag !== "Ok") return;
  const plan = preview.value.data;
  expect(plan.cut).toBe(scenario.cut);
  expect(plan.target).toBe(target);
  expect(git(scenario.child.worktree, "rev-parse", "HEAD")).toBe(original);
  expect(await stack({ ...scenario.input, action: "apply", plan: plan.id })).toMatchObject({
    tag: "Ok",
    value: { reason: "stack_refreshed", data: { step: "complete" } },
  });
  const head = git(scenario.child.worktree, "rev-parse", "HEAD");
  expect(head).not.toBe(original);
  expect(git(scenario.child.worktree, "diff", `${target}...HEAD`, "--name-only")).toBe("child");
  expect(
    git(scenario.child.worktree, "rev-parse", `refs/operator/stacks/${plan.id}/original`),
  ).toBe(original);
  expect(git(scenario.parent.worktree, "rev-parse", "HEAD")).toBe(target);
  const row = DeviceState.readStack(device.paths, scenario.child.launchId, plan.id);
  expect(row).toMatchObject({ tag: "Ok", value: { state: "complete", ownerPid: null } });
  expect(await stack({ ...scenario.input, action: "apply", plan: plan.id })).toMatchObject({
    tag: "Ok",
    value: { reason: "stack_unchanged" },
  });
  expect(git(scenario.child.worktree, "rev-parse", "HEAD")).toBe(head);
});

test("a moved pinned parent blocks effects, records its failure, and supports safe cancellation", async () => {
  await using device = await prDevice();
  const scenario = await stackScenario(device);
  const original = git(scenario.child.worktree, "rev-parse", "HEAD");
  const preview = await stack({ ...scenario.input, action: "plan" });
  expect(preview).toMatchObject({ tag: "Ok" });
  if (preview.tag !== "Ok") return;
  await commit(scenario.parent.worktree, "later", "later\n");
  git(scenario.parent.worktree, "push", "-q");
  const id = preview.value.data.id;
  expect(await stack({ ...scenario.input, action: "apply", plan: id })).toMatchObject({
    tag: "Err",
    error: { reason: "stack_stale" },
  });
  expect(git(scenario.child.worktree, "rev-parse", "HEAD")).toBe(original);
  expect(DeviceState.readStack(device.paths, scenario.child.launchId, id)).toMatchObject({
    tag: "Ok",
    value: { state: "blocked" },
  });
  expect(await stack({ ...scenario.input, action: "cancel", plan: id })).toMatchObject({
    tag: "Ok",
    value: { reason: "stack_cancelled" },
  });
  expect(git(scenario.child.worktree, "rev-parse", "HEAD")).toBe(original);
});

test("stack commands resolve only their own associated worktree and refuse dirty work before planning", async () => {
  await using device = await prDevice();
  expect(await stack({ paths: device.paths, cwd: device.checkout, action: "plan" })).toMatchObject({
    tag: "Err",
    error: { reason: "pr_worktree_unrecorded" },
  });
  const { launchId, worktree } = device.start("other");
  device.associate(launchId, 7, "task/other");
  const head = git(worktree, "rev-parse", "HEAD");
  device.answer(() => succeeded(associationBody([{ number: 7, base: "main" }])));
  await Bun.write(`${worktree}/unlanded`, "keep this\n");
  expect(await stack({ paths: device.paths, cwd: worktree, action: "plan" })).toMatchObject({
    tag: "Err",
    error: { reason: "stack_unclean" },
  });
  expect(await Bun.file(`${worktree}/unlanded`).text()).toBe("keep this\n");
  expect(git(worktree, "rev-parse", "HEAD")).toBe(head);
  expect(
    await stack({ paths: device.paths, cwd: worktree, action: "apply", plan: "unknown" }),
  ).toMatchObject({ tag: "Err", error: { reason: "stack_stale" } });
  await commit(worktree, "unlanded", "keep this\n");
  expect(git(worktree, "show", "HEAD:unlanded")).toBe("keep this");
});
