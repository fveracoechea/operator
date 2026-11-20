import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import { workerDevice } from "./worker-fixture.ts";
import { sourceArgs } from "./sources.ts";
import { questionArgs } from "./questions.ts";
import { pullRequestArgs } from "./pull-requests.ts";
import { reviewDevice, url } from "./review-fixture.ts";
import { fixtureCommand } from "./command-fixture.ts";

let device: Awaited<ReturnType<typeof workerDevice>> | undefined;
let review: Awaited<ReturnType<typeof reviewDevice>> | undefined;
afterEach(async () => {
  if (device !== undefined) await rm(device.root, { recursive: true, force: true });
  device = undefined;
  if (review !== undefined) await rm(review.root, { recursive: true, force: true });
  review = undefined;
});

test("the coordination wait runs review upkeep", async () => {
  review = await reviewDevice();
  const request = await review.add();
  const args = ["next", "--wait", "--timeout", "0"];
  expect(await review.run(args, review.checkout)).toMatchObject({
    code: 0,
    output: { reason: "next_actions_changed", data: { requests: [{ action: "start_reviewer" }] } },
  });
  expect(await review.run(args, review.checkout)).toMatchObject({
    code: 0,
    output: { reason: "next_wait_timed_out", data: { sources: [], requests: [], events: [] } },
  });
  expect((await review.run(["review", "start", url])).code).toBe(0);
  await review.draft(request.draft, review.head, {
    blockers: [{ short: "Missing guard", detail: "Cover the guard." }],
  });
  expect((await review.run(["review", "post", url])).code).toBe(0);
  await review.pullRequest({
    reviewRequests: [{ reviewer: "owner", createdAt: new Date().toISOString() }],
  });
  expect(await review.run(args, review.checkout)).toMatchObject({
    code: 0,
    output: {
      reason: "next_actions_changed",
      data: {
        events: [{ kind: "round_started", trigger: "re-request" }],
        requests: [{ round: { number: 2 } }],
      },
    },
  });
  expect(await review.run(args, review.checkout)).toMatchObject({
    code: 0,
    output: { reason: "next_wait_timed_out", data: { events: [], requests: [] } },
  });
}, 120000);

test("review wait is not a command", async () => {
  device = await workerDevice();
  expect(await device.run(["review", "wait", "--timeout", "0"])).toMatchObject({ code: 2 });
}, 60000);

test("a quiet first coordination wait reaches its deadline and prints one retry line", async () => {
  device = await workerDevice();
  const started = Date.now();
  expect(await device.run(["next", "--wait", "--timeout", "1"])).toMatchObject({
    code: 0,
    output: {
      reason: "next_wait_timed_out",
      next: { command: "operator next --wait --timeout 1" },
      data: { sources: [], requests: [], events: [] },
    },
  });
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  const text = await device.exec(
    [...fixtureCommand().argv, "next", "--wait", "--timeout", "0"],
    device.main,
  );
  expect(text.code, text.stderr).toBe(0);
  expect(text.stdout.trim().split("\n")).toEqual([
    "operator: next_wait_timed_out; next: operator next --wait --timeout 0",
  ]);
}, 60000);

test("a source wait leaves unrelated manual review requests untouched", async () => {
  review = await reviewDevice();
  await review.add();
  const file = `${review.root}/plan.json`;
  await Bun.write(
    file,
    JSON.stringify({
      trackerKey: "github:example/one#20",
      assignments: [
        {
          key: "read",
          trackerKey: "github:example/one#21",
          kind: "research",
          resources: "pane",
          instructions: "Read the issue.",
          dependencies: [],
        },
      ],
    }),
  );
  const registered = await review.run(["source", "register", "--file", file], review.checkout);
  expect(registered.code, registered.stderr).toBe(0);
  const source = z.object({ data: z.object({ id: z.string() }) }).parse(registered.output).data.id;
  expect(
    await review.run(
      ["next", "--wait", "--source", source, "--timeout", "1000000"],
      review.checkout,
    ),
  ).toMatchObject({
    code: 0,
    output: {
      reason: "next_actions_changed",
      data: { requests: [], events: [], sources: [{ actions: [{ action: "ready_assignment" }] }] },
    },
  });
  expect(await review.next()).toMatchObject([{ action: "start_reviewer", state: "queued" }]);
  expect(await review.wait(0)).toMatchObject({
    output: { reason: "next_actions_changed", data: { requests: [{ action: "start_reviewer" }] } },
  });
}, 60000);

test("an unchanged failed review read does not flood coordination wakes", async () => {
  review = await reviewDevice();
  await review.add();
  await review.github({ fail: "first temporary outage" });
  expect(await review.wait(0)).toMatchObject({
    code: 0,
    output: {
      reason: "next_actions_changed",
      data: {
        events: [{ kind: "read_failed" }],
        requests: [{ next: { command: `operator review start ${url}` } }],
      },
    },
  });
  await review.github({ fail: "another diagnostic for the same outage" });
  expect(await review.wait(0)).toMatchObject({
    code: 0,
    output: { reason: "next_wait_timed_out", data: { events: [], requests: [] } },
  });
  expect(await review.wait(31)).toMatchObject({
    code: 0,
    output: { reason: "next_wait_timed_out", data: { events: [], requests: [] } },
  });
}, 60000);

test("each wait defaults to 540 seconds and accepts longer timeouts", () => {
  for (const [parse, args] of [
    [sourceArgs, ["next", "--wait"]],
    [questionArgs, ["question", "wait", "--key", "scope"]],
    [pullRequestArgs, ["pr", "wait"]],
  ] as const) {
    expect(parse([...args])).toMatchObject({ timeoutSeconds: 540 });
    expect(parse([...args, "--timeout", "1000000"])).toMatchObject({ timeoutSeconds: 1000000 });
    expect(parse([...args, "--timeout", "9007199254740992"])).toBeNull();
  }
});
