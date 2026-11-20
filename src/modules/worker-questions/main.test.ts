import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Err } from "unthrown";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import { WorkSources } from "../work-sources/main.ts";
import { DeviceState } from "../device-state/main.ts";
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
  const file = await device.write(`${key}.json`, "Is b.ts in scope?");
  const pane = device.inPane(workerPane);
  const result = await WorkerQuestions.ask({ paths: device.paths, key, file });
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
  const result = await WorkerQuestions.answer({ ...selector(sourceId), by, file });
  mock.restore();
  return result;
}

function wait(key = "scope", timeoutSeconds = 0) {
  device.inPane(workerPane);
  return WorkerQuestions.wait({ paths: device.paths, key, timeoutSeconds });
}

test("an answered question resumes worker work rather than instructing another immediate wait", async () => {
  const { sourceId } = await asked();
  okValue(await answer(sourceId, "person", "Only a.ts."));
  for (let i = 0; i < 3; i++) {
    const result = okValue(await wait("scope", 540));
    expect(result).toMatchObject({ reason: "question_answered", data: { answer: "Only a.ts." } });
    expect(result.next?.command).not.toBe("operator question wait --key scope");
  }
});

test("a pane reread retargeted to another assignment refuses the missing question with its recovery", async () => {
  const sourceId = await device.source();
  device.launch(sourceId);
  const target = {
    by: "key",
    repository: "example/one",
    checkout: device.checkout,
    sourceId,
    assignment: "later",
  } as const;
  const reread = DeviceState.readQuestion(device.paths, target, "scope");
  expect(reread).toMatchObject({
    tag: "Ok",
    value: { assignment: { key: "later" }, question: null },
  });
  const read = DeviceState.readQuestion;
  const observed = spyOn(DeviceState, "readQuestion").mockReturnValue(reread);
  device.inPane(workerPane);
  const file = await device.write("q.md", "Which scope?");
  expect(await WorkerQuestions.ask({ paths: device.paths, key: "scope", file })).toMatchObject({
    tag: "Err",
    error: {
      reason: "question_defect",
      detail: "The question is not recorded.",
      next: {
        decider: "super-agent",
        question: "Why is the changed question missing from its recorded assignment?",
      },
    },
  });
  expect(observed).toHaveBeenCalledTimes(1);
  observed.mockRestore();
  expect(read(device.paths, { ...target, assignment: "read" }, "scope")).toMatchObject({
    tag: "Ok",
    value: { question: { state: "open", question: "Which scope?" } },
  });
  expect(read(device.paths, target, "scope")).toMatchObject({
    tag: "Ok",
    value: { question: null },
  });
  expect(device.doorbells).toEqual([]);
});

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

test("concurrent waits deliver an already escalated question once and still deliver its answer", async () => {
  const { sourceId } = await asked();
  device.inPane(superPane);
  okValue(await WorkerQuestions.escalate(selector(sourceId)));
  mock.restore();
  const notices = await Promise.all([wait(), wait()]);
  expect(notices.map((notice) => okValue(notice).reason).toSorted()).toEqual([
    "question_awaiting_person",
    "question_wait_timed_out",
  ]);
  for (const notice of notices)
    expect(okValue(notice).next).toMatchObject({ command: "operator question wait --key scope" });
  expect(okValue(await wait()).reason).toBe("question_wait_timed_out");
  okValue(await answer(sourceId, "person"));
  expect(okValue(await wait())).toMatchObject({
    reason: "question_answered",
    data: { answer: "No, only a.ts.", by: "person" },
  });
});

test.each(["withdrawn", "missing"])(
  "a %s question cannot claim a stale person notice",
  async (state) => {
    const { sourceId } = await asked();
    device.inPane(superPane);
    okValue(await WorkerQuestions.escalate(selector(sourceId)));
    mock.restore();
    const change = DeviceState.changeQuestion;
    spyOn(DeviceState, "changeQuestion").mockImplementationOnce((paths, target, key, decide) => {
      using db = new Database(device.paths.database);
      if (state === "missing") db.exec("DELETE FROM worker_questions");
      else db.exec("UPDATE worker_questions SET state = 'withdrawn'");
      return change(paths, target, key, decide);
    });
    const result = await wait();
    if (state === "missing")
      expect(result).toMatchObject({ tag: "Err", error: { reason: "question_not_found" } });
    else
      expect(okValue(result)).toMatchObject({
        reason: "question_withdrawn",
        data: { state: "withdrawn" },
      });
    using db = new Database(device.paths.database, { readonly: true });
    expect(db.query("SELECT awaiting_person_seen_at FROM worker_questions").all()).toEqual(
      state === "missing" ? [] : [{ awaiting_person_seen_at: null }],
    );
  },
);

test("a failed receipt write refuses without claiming the person notice", async () => {
  const { sourceId } = await asked();
  device.inPane(superPane);
  okValue(await WorkerQuestions.escalate(selector(sourceId)));
  mock.restore();
  const receipt = spyOn(DeviceState, "changeQuestion").mockReturnValueOnce(
    Err({ reason: "state_busy", detail: "The synthetic writer is busy." }),
  );
  expect(await wait()).toMatchObject({ tag: "Err", error: { reason: "state_busy" } });
  receipt.mockRestore();
  expect(okValue(await wait()).reason).toBe("question_awaiting_person");
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
      next: {
        decider: "super-agent",
        question: "Which recorded question key should this command target?",
      },
      state: { question: null },
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
  expect(okValue(await wait()).next).toBeUndefined();
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
  const file = await device.write("q.md", "Which?");
  device.inPane(null);
  expect(await WorkerQuestions.ask({ paths: device.paths, key: "scope", file })).toMatchObject({
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
  expect(await WorkerQuestions.ask({ paths: device.paths, key: "scope", file })).toMatchObject({
    error: { reason: "worker_launch_not_found" },
  });
  device.launch(sourceId);
  okValue(await WorkerQuestions.ask({ paths: device.paths, key: "scope", file }));
  expect(await WorkerQuestions.ask({ paths: device.paths, key: "scope", file })).toMatchObject({
    error: { reason: "question_key_taken" },
  });
  const text = await device.write("answer.md", "Mine.");
  expect(
    await WorkerQuestions.answer({
      ...selector(sourceId),
      by: "super-agent",
      file: text,
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
  for (const content of ["", JSON.stringify({ key: "Bad Key", question: "Which?" })]) {
    const file = await device.write("bad.json", content);
    expect(await WorkerQuestions.ask({ paths: device.paths, key: "Bad Key", file })).toMatchObject({
      error: { reason: "invalid_question_input" },
    });
  }
  expect(
    await WorkerQuestions.ask({
      paths: device.paths,
      key: "scope",
      file: `${device.root}/missing.json`,
    }),
  ).toMatchObject({ error: { reason: "question_io_failed" } });
  const file = await device.write("q.md", "Which?");
  okValue(await WorkerQuestions.ask({ paths: device.paths, key: "scope", file }));
  mock.restore();
  const empty = await device.write("empty.md", "  \n");
  device.inPane(superPane);
  expect(
    await WorkerQuestions.answer({
      ...selector(sourceId),
      by: "super-agent",
      file: empty,
    }),
  ).toMatchObject({ error: { reason: "invalid_question_input" } });
  expect((await device.actions())[0]).toMatchObject({ action: "answer_question" });
});
