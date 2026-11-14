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
import { storedLaunch, storedPullRequest, storedQuestion, storedSource } from "./source-fixture.ts";

const root = await mkdtemp(path.join(tmpdir(), "operator-source-questions-"));
const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
afterEach(() => {
  mock.restore();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function next(row: ReturnType<typeof storedSource>) {
  spyOn(Projects, "current").mockReturnValue(
    OkAsync({
      reason: "project_resolved" as const,
      data: { repository: "example/one", checkout: root, registeredAt: "now" },
    }),
  );
  spyOn(DeviceState, "readSources").mockReturnValue(Ok([row]));
  const result = await WorkSources.next({ paths, cwd: root });
  expect(result.tag).toBe("Ok");
  return result.tag === "Ok" ? result.value.sources[0] : expect.unreachable("next refused");
}

const idle = { activity: "idle", activityAt: "2026-01-03T00:00:00.000Z" };

function question(key: string, assignment = "read") {
  return {
    assignment,
    action: "answer_question" as const,
    reason: "question_open" as const,
    blockers: [],
    question: { key, question: `Is ${assignment} in scope?`, askedAt: "2026-01-03T00:00:00.000Z" },
  };
}

test("an open question replaces the idle worker, and its asked order holds", async () => {
  const source = await next(
    storedSource([{ key: "read", completion: "report", state: "running" }], {
      launches: [storedLaunch("read", idle)],
      questions: [storedQuestion("read"), storedQuestion("read", { key: "name" })],
    }),
  );
  expect(source?.actions).toEqual([question("scope"), question("name")]);
  expect(source?.waits).toEqual([]);
});

test("a question of an idle PR owner replaces the owner attention", async () => {
  const source = await next(
    storedSource([{ key: "change", completion: "pr", state: "pr-open" }], {
      launches: [storedLaunch("change", idle)],
      pullRequests: [storedPullRequest("change")],
      questions: [storedQuestion("change")],
    }),
  );
  expect(source?.actions).toEqual([question("scope", "change")]);
});

test("a question stands beside the worker's other state, and ahead of it", async () => {
  // A working worker keeps its wait beside the question.
  const working = await next(
    storedSource([{ key: "read", completion: "report", state: "running" }], {
      launches: [storedLaunch("read")],
      questions: [storedQuestion("read")],
    }),
  );
  expect(working?.actions).toEqual([question("scope")]);
  expect(working?.waits).toMatchObject([{ assignment: "read", reason: "assignment_active" }]);
  // A failed worker still needs a replacement, which is no idle attention.
  const failed = await next(
    storedSource([{ key: "read", completion: "report", state: "running" }], {
      launches: [storedLaunch("read", { state: "failed", ...idle })],
      questions: [storedQuestion("read")],
    }),
  );
  expect(failed?.actions).toMatchObject([
    question("scope"),
    { assignment: "read", action: "replace_worker", reason: "launch_failed" },
  ]);
});

test("a question that waits on the person is a person decision, and an ended one is gone", async () => {
  const source = await next(
    storedSource([{ key: "read", completion: "report", state: "running" }], {
      launches: [storedLaunch("read", idle)],
      questions: [
        storedQuestion("read", { state: "awaiting_person" }),
        storedQuestion("read", {
          key: "done",
          state: "answered",
          answer: "Yes.",
          answeredBy: "super-agent",
          answeredAt: "later",
        }),
        storedQuestion("read", { key: "gone", state: "withdrawn", endedAt: "later" }),
      ],
    }),
  );
  expect(source?.actions).toEqual([
    {
      ...question("scope"),
      action: "person_decision",
      reason: "question_awaiting_person",
    },
  ]);
  // With no unanswered question, the idle worker is attention again.
  const answered = await next(
    storedSource([{ key: "read", completion: "report", state: "running" }], {
      launches: [storedLaunch("read", idle)],
      questions: [storedQuestion("read", { state: "withdrawn", endedAt: "later" })],
    }),
  );
  expect(answered?.actions).toMatchObject([
    { assignment: "read", action: "worker_attention", reason: "worker_idle" },
  ]);
});
