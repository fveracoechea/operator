import { afterEach, beforeEach, expect, mock, test } from "bun:test";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import { WorkSources } from "../work-sources/main.ts";
import { WorkerQuestions } from "./main.ts";
import { okValue, questionDevice, superPane, workerPane } from "./question-fixture.ts";

let device: Awaited<ReturnType<typeof questionDevice>>;
beforeEach(async () => {
  device = await questionDevice();
});
afterEach(async () => {
  mock.restore();
  await rm(device.root, { recursive: true, force: true });
});

/** A running worker of `read` asks question `scope` from its own pane. */
async function asked(key = "scope") {
  const sourceId = await device.source();
  const launchId = device.launch(sourceId);
  const file = await device.write(
    `${key}.json`,
    JSON.stringify({ key, question: "Is b.ts in scope?" }),
  );
  const pane = device.inPane(workerPane);
  const result = await WorkerQuestions.ask({ paths: device.paths, file });
  pane.mockRestore();
  const askedAt = result.tag === "Ok" ? result.value.data.askedAt : "";
  return { sourceId, launchId, result, askedAt };
}

function selector(sourceId: string, key = "scope") {
  return { paths: device.paths, cwd: device.checkout, sourceId, assignment: "read", key };
}

async function answer(sourceId: string, by: "super-agent" | "person", text = "No, only a.ts.") {
  const file = await device.write("answer.md", `${text}\n`);
  device.inPane(superPane);
  const result = await WorkerQuestions.answer({ ...selector(sourceId), by, file, text: null });
  mock.restore();
  return result;
}

function wait(key = "scope", timeoutSeconds = 0) {
  device.inPane(workerPane);
  return WorkerQuestions.wait({ paths: device.paths, key, timeoutSeconds });
}

test("an asked question replaces the idle worker in next actions until the SuperAgent answers", async () => {
  const { sourceId, result, askedAt } = await asked();
  expect(askedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(okValue(result)).toEqual({
    reason: "question_asked",
    next: { command: "operator question wait --key scope", why: "Wait for the recorded answer." },
    data: {
      sourceId,
      assignment: "read",
      key: "scope",
      state: "open",
      question: "Is b.ts in scope?",
      askedAt,
      answer: null,
      by: null,
      answeredAt: null,
    },
  });
  // The worker ended its turn after it asked, so its host is idle.
  device.observe({ exited: false, activity: "idle" });
  const [first, second, ...rest] = await device.actions();
  expect(first).toEqual({
    assignment: "read",
    action: "answer_question",
    reason: "question_open",
    blockers: [],
    question: { key: "scope", question: "Is b.ts in scope?", askedAt },
  });
  expect(second).toMatchObject({ assignment: "later", action: "ready_assignment" });
  expect(rest).toEqual([]);
  expect(okValue(await answer(sourceId, "super-agent"))).toMatchObject({
    reason: "question_answered",
    data: { key: "scope", state: "answered", answer: "No, only a.ts.", by: "super-agent" },
  });
  // An answered question leaves the worker's own state to explain it.
  expect(await device.actions()).toMatchObject([
    { assignment: "read", action: "worker_attention" },
    { assignment: "later", action: "ready_assignment" },
  ]);
  const read = okValue(await wait());
  expect(read).toMatchObject({
    reason: "question_answered",
    data: { answer: "No, only a.ts.", by: "super-agent" },
  });
  expect(read.data.answeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

test("a question that needs the person shows as a person decision and records a person answer", async () => {
  const { sourceId, askedAt } = await asked();
  device.inPane(superPane);
  expect(okValue(await WorkerQuestions.escalate(selector(sourceId)))).toMatchObject({
    reason: "question_escalated",
    data: { state: "awaiting_person" },
  });
  mock.restore();
  expect((await device.actions())[0]).toEqual({
    assignment: "read",
    action: "person_decision",
    reason: "question_awaiting_person",
    blockers: [],
    question: { key: "scope", question: "Is b.ts in scope?", askedAt },
  });
  // The running worker is not idle, so its own wait stays beside the question.
  expect(await device.actions()).toHaveLength(2);
  expect(okValue(await answer(sourceId, "person", "Yes, b.ts too."))).toMatchObject({
    data: { state: "answered", by: "person", answer: "Yes, b.ts too." },
  });
  expect((await device.actions()).map((row) => row.action)).toEqual(["ready_assignment"]);
});

test("a wait returns the answer that arrives while it waits, and the move to the person", async () => {
  const { sourceId } = await asked();
  const waiting = wait("scope", 10);
  await Bun.sleep(50);
  device.inPane(superPane);
  okValue(await WorkerQuestions.escalate(selector(sourceId)));
  expect(okValue(await waiting)).toMatchObject({
    reason: "question_awaiting_person",
    data: { state: "awaiting_person", answer: null },
  });
  const again = wait("scope", 10);
  await Bun.sleep(1100);
  expect(okValue(await answer(sourceId, "person"))).toMatchObject({ data: { by: "person" } });
  expect(okValue(await again)).toMatchObject({
    reason: "question_answered",
    data: { state: "answered", by: "person" },
  });
});

test("a wait times out with the question's current state and records nothing", async () => {
  await asked();
  const started = Date.now();
  expect(okValue(await wait("scope", 1))).toMatchObject({
    reason: "question_wait_timed_out",
    next: { command: "operator question wait --key scope", why: "Wait for the recorded answer." },
    data: { key: "scope", state: "open", answer: null },
  });
  expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  expect(okValue(await wait())).toMatchObject({ reason: "question_wait_timed_out" });
  expect(await wait("missing")).toMatchObject({
    tag: "Err",
    error: {
      reason: "question_not_found",
      detail: "Assignment read has no question missing. Nothing changed.",
    },
  });
});

test("the worker withdraws its question, which then takes no answer", async () => {
  const { sourceId } = await asked();
  device.inPane(workerPane);
  expect(
    okValue(await WorkerQuestions.withdraw({ paths: device.paths, key: "scope" })),
  ).toMatchObject({ reason: "question_withdrawn", data: { state: "withdrawn" } });
  expect(okValue(await wait())).toMatchObject({ reason: "question_withdrawn" });
  mock.restore();
  expect((await device.actions()).map((row) => row.action)).toEqual(["ready_assignment"]);
  expect(await answer(sourceId, "super-agent")).toMatchObject({
    error: { reason: "question_not_open" },
  });
  device.inPane(workerPane);
  expect(await WorkerQuestions.withdraw({ paths: device.paths, key: "scope" })).toMatchObject({
    error: { reason: "question_not_open" },
  });
});

test("a reset abandons the open question, which then takes no answer", async () => {
  const { sourceId } = await asked();
  // A reset needs every worker pane closed first.
  device.observe({ exited: true });
  okValue(
    await WorkSources.reset({
      paths: device.paths,
      cwd: device.checkout,
      sourceId,
      personInstructed: true,
    }),
  );
  expect(await answer(sourceId, "super-agent")).toMatchObject({
    error: {
      reason: "question_not_open",
      detail: "Question scope of read is abandoned. Nothing changed.",
    },
  });
  expect((await device.actions()).map((row) => row.action)).toEqual(["source_ended"]);
});

test("only the worker's pane asks, and only another pane answers or moves the question", async () => {
  const sourceId = await device.source();
  const file = await device.write("q.json", JSON.stringify({ key: "scope", question: "Which?" }));
  device.inPane(null);
  expect(await WorkerQuestions.ask({ paths: device.paths, file })).toMatchObject({
    error: { reason: "worker_pane_required" },
  });
  expect(
    await WorkerQuestions.wait({ paths: device.paths, key: "scope", timeoutSeconds: 0 }),
  ).toMatchObject({ error: { reason: "worker_pane_required" } });
  expect(await WorkerQuestions.withdraw({ paths: device.paths, key: "scope" })).toMatchObject({
    error: { reason: "worker_pane_required" },
  });
  mock.restore();
  device.inPane(workerPane);
  expect(await WorkerQuestions.ask({ paths: device.paths, file })).toMatchObject({
    error: { reason: "worker_launch_not_found" },
  });
  device.launch(sourceId);
  okValue(await WorkerQuestions.ask({ paths: device.paths, file }));
  expect(await WorkerQuestions.ask({ paths: device.paths, file })).toMatchObject({
    error: { reason: "question_key_taken" },
  });
  const text = await device.write("answer.md", "Mine.");
  expect(
    await WorkerQuestions.answer({
      ...selector(sourceId),
      by: "super-agent",
      file: text,
      text: null,
    }),
  ).toMatchObject({ error: { reason: "self_decision_refused" } });
  expect(await WorkerQuestions.escalate(selector(sourceId))).toMatchObject({
    error: { reason: "self_decision_refused" },
  });
  mock.restore();
  device.inPane(superPane);
  expect(await WorkerQuestions.escalate({ ...selector(sourceId), key: "other" })).toMatchObject({
    error: { reason: "question_not_found" },
  });
  expect(await WorkerQuestions.escalate({ ...selector(sourceId), cwd: device.root })).toMatchObject(
    { tag: "Err" },
  );
});

test("an invalid draft or a missing file refuses and records nothing", async () => {
  const sourceId = await device.source();
  device.launch(sourceId);
  device.inPane(workerPane);
  for (const content of ["{", JSON.stringify({ key: "Bad Key", question: "Which?" })]) {
    const file = await device.write("bad.json", content);
    expect(await WorkerQuestions.ask({ paths: device.paths, file })).toMatchObject({
      error: { reason: "invalid_question_input" },
    });
  }
  expect(
    await WorkerQuestions.ask({ paths: device.paths, file: `${device.root}/missing.json` }),
  ).toMatchObject({ error: { reason: "question_io_failed" } });
  const file = await device.write("q.json", JSON.stringify({ key: "scope", question: "Which?" }));
  okValue(await WorkerQuestions.ask({ paths: device.paths, file }));
  mock.restore();
  const empty = await device.write("empty.md", "  \n");
  device.inPane(superPane);
  expect(
    await WorkerQuestions.answer({
      ...selector(sourceId),
      by: "super-agent",
      file: empty,
      text: null,
    }),
  ).toMatchObject({ error: { reason: "invalid_question_input" } });
  // Text in place of a file passes the same check, and the file is not read.
  expect(
    await WorkerQuestions.answer({
      ...selector(sourceId),
      by: "super-agent",
      file: `${device.root}/missing.md`,
      text: " ",
    }),
  ).toMatchObject({ error: { reason: "invalid_question_input" } });
  expect((await device.actions())[0]).toMatchObject({ action: "answer_question" });
});
