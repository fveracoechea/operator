import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Ok, OkAsync } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { WorkSources } from "./main.ts";
import { storedLaunch, storedMessage, storedQuestion, storedSource } from "./source-fixture.ts";

const root = await mkdtemp(path.join(tmpdir(), "operator-source-messages-"));
const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
afterEach(() => {
  mock.restore();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const now = Date.parse("2026-01-03T01:00:00.000Z");
const minute = 60 * 1000;

async function next(messages: ReturnType<typeof storedMessage>[], launch = {}) {
  spyOn(Date, "now").mockReturnValue(now);
  spyOn(Projects, "current").mockReturnValue(
    OkAsync({
      reason: "project_resolved" as const,
      data: { repository: "example/one", checkout: root, registeredAt: "now" },
    }),
  );
  spyOn(DeviceState, "readSources").mockReturnValue(
    Ok([
      storedSource([{ key: "read", completion: "report", state: "running" }], {
        launches: [storedLaunch("read", launch)],
        messages,
      }),
    ]),
  );
  const result = await WorkSources.next({ paths, cwd: root });
  expect(result.tag).toBe("Ok");
  return result.tag === "Ok" ? result.value.sources[0] : expect.unreachable("next refused");
}

function ago(minutes: number) {
  return new Date(now - minutes * minute).toISOString();
}

const shown = { key: "focus", message: "Focus read on a.ts.", questionKey: null };

test("a pending message stays quiet within the period since its last ring", async () => {
  const source = await next([storedMessage("read", { sentAt: ago(60), rungAt: ago(14) })]);
  expect(source?.actions).toEqual([]);
  expect(source?.waits).toMatchObject([{ assignment: "read", reason: "assignment_active" }]);
});

test("a message left pending past the period needs worker attention", async () => {
  const source = await next([storedMessage("read", { sentAt: ago(60), rungAt: ago(15) })]);
  expect(source?.actions).toEqual([
    {
      assignment: "read",
      action: "worker_attention",
      reason: "message_unacknowledged",
      blockers: [],
      message: { ...shown, sentAt: ago(60), rungAt: ago(15), doorbellFailure: null },
    },
  ]);
  // A message whose doorbell never rang counts from its send.
  const unrung = await next([storedMessage("read", { sentAt: ago(16), rungAt: null })]);
  expect(unrung?.actions).toMatchObject([{ reason: "message_unacknowledged" }]);
});

test("a failed doorbell needs worker attention at once", async () => {
  const source = await next([
    storedMessage("read", { sentAt: ago(1), rungAt: ago(1), doorbellFailure: "herdr_failed: x" }),
  ]);
  expect(source?.actions).toMatchObject([
    {
      action: "worker_attention",
      reason: "doorbell_failed",
      message: { key: "focus", doorbellFailure: "herdr_failed: x" },
    },
  ]);
});

test("a reply waits on the SuperAgent until it closes the message", async () => {
  const replied = { state: "replied", acknowledgedAt: ago(1), reply: "On it." };
  const source = await next([storedMessage("read", { ...replied, sentAt: ago(2) })]);
  expect(source?.actions).toEqual([
    {
      assignment: "read",
      action: "read_reply",
      reason: "message_replied",
      blockers: [],
      message: { ...shown, sentAt: ago(2), reply: "On it." },
    },
  ]);
  for (const ended of [
    { state: "acknowledged", acknowledgedAt: ago(1) },
    { ...replied, state: "closed" },
    { state: "abandoned" },
  ]) {
    const quiet = await next([
      storedMessage("read", { ...ended, sentAt: ago(60), endedAt: ago(1) }),
    ]);
    expect(quiet?.actions).toEqual([]);
  }
});

test("an open message replaces the idle worker, after the assignment's questions", async () => {
  spyOn(Date, "now").mockReturnValue(now);
  spyOn(Projects, "current").mockReturnValue(
    OkAsync({
      reason: "project_resolved" as const,
      data: { repository: "example/one", checkout: root, registeredAt: "now" },
    }),
  );
  spyOn(DeviceState, "readSources").mockReturnValue(
    Ok([
      storedSource([{ key: "read", completion: "report", state: "running" }], {
        launches: [storedLaunch("read", { activity: "idle", activityAt: ago(30) })],
        questions: [storedQuestion("read")],
        messages: [storedMessage("read", { sentAt: ago(30), rungAt: ago(30) })],
      }),
    ]),
  );
  const result = await WorkSources.next({ paths, cwd: root });
  const source = result.tag === "Ok" ? result.value.sources[0] : undefined;
  expect(source?.actions).toMatchObject([
    { action: "answer_question", reason: "question_open" },
    { action: "worker_attention", reason: "message_unacknowledged" },
  ]);
  // Without a recorded reason, the idle worker is attention as before.
  const idle = await next([], { activity: "idle", activityAt: ago(30) });
  expect(idle?.actions).toMatchObject([{ action: "worker_attention", reason: "worker_idle" }]);
});
