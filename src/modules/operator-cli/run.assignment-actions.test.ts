import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { workerDevice } from "./worker-fixture.ts";

let device: Awaited<ReturnType<typeof workerDevice>>;
beforeEach(async () => {
  device = await workerDevice({ github: true });
});
afterEach(async () => {
  await rm(device.root, { recursive: true, force: true });
});

test("a stopped PR wait keeps its live worker, idle attention names steering, and a missing owner names replacement", async () => {
  const source = await device.register({
    trackerKey: "assignment-actions:interrupted-owner",
    assignments: [
      {
        key: "work",
        trackerKey: "APP-1",
        instructions: "Implement the guard.",
        kind: "implementation",
        resources: "worktree",
        branch: "task/work",
        dependencies: [],
      },
    ],
  });
  const worker = await device.dispatch(source, "work");
  const worktree = worker.worktreePath ?? expect.unreachable("The PR worker needs its worktree.");
  const head = (await device.exec(["git", "rev-parse", "HEAD"], worktree)).stdout.trim();
  await Bun.write(
    `${device.root}/github.json`,
    JSON.stringify({
      pulls: [
        {
          number: 7,
          url: "https://github.com/example/one/pull/7",
          headRefName: "task/work",
          headRefOid: head,
          headRepository: "example/one",
          state: "OPEN",
          isDraft: true,
        },
      ],
    }),
  );
  expect(
    await device.run(["pr", "associate"], { cwd: worktree, pane: worker.paneId }),
  ).toMatchObject({ code: 0 });
  await Bun.write(
    `${device.root}/github.json`,
    JSON.stringify({ fail: "Synthetic GitHub read failure" }),
  );
  expect(
    await device.run(["pr", "wait", "--timeout", "0"], { cwd: worktree, pane: worker.paneId }),
  ).toMatchObject({ code: 1, output: { reason: "github_uncertain" } });
  expect(await device.next("work")).toMatchObject([
    { action: "wait", reason: "assignment_active", pullRequest: { wait: "stopped" } },
  ]);
  expect(
    (
      await device.event("pane.agent_status_changed", {
        pane_id: worker.paneId,
        agent_status: "idle",
      })
    ).code,
  ).toBe(0);
  expect(await device.next("work")).toMatchObject([
    { action: "worker_attention", reason: "worker_idle", next: { decider: "super-agent" } },
  ]);
  const before = await device.herdrCalls();
  expect(await device.run(["dispatch", "--source", source, "--assignment", "work"])).toMatchObject({
    code: 4,
    output: { reason: "assignment_not_dispatchable" },
  });
  expect(
    (await device.herdrCalls())
      .slice(before.length)
      .filter((call) => call !== "agent list" && call !== "pane get"),
  ).toEqual([]);
  expect(
    (await device.exec(["herdr", "pane", "exit", worker.paneId, "w1"], device.main)).code,
  ).toBe(0);
  expect(await device.next("work")).toMatchObject([
    {
      action: "replace_worker",
      reason: "worker_interrupted",
      pullRequest: { wait: "stopped" },
      next: { command: `operator dispatch --source ${source} --assignment work` },
    },
  ]);
  expect(await Bun.file(`${worktree}/package.json`).exists()).toBe(true);
});
