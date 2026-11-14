import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Err, fromSafePromise } from "unthrown";
import { Herdr } from "../herdr/main.ts";
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

function selector(sourceId: string, key = "focus") {
  return { paths: device.paths, cwd: device.checkout, sourceId, assignment: "read", key };
}

/** A running worker of `read`, and the SuperAgent's message `focus` to it. */
async function sent(key = "focus") {
  const sourceId = await device.source();
  const launchId = device.launch(sourceId);
  const file = await device.write(
    `${key}.json`,
    JSON.stringify({ key, message: "  Focus on a.ts first.\n" }),
  );
  device.inPane(superPane);
  const result = await WorkerQuestions.send({ ...selector(sourceId), file });
  mock.restore();
  return { sourceId, launchId, result };
}

function fromWorker<T>(run: () => T) {
  device.inPane(workerPane);
  const result = run();
  return result;
}

test("a sent message rings the worker's doorbell, and the worker reads and acknowledges it", async () => {
  const { sourceId, launchId, result } = await sent();
  const data = okValue(result);
  expect(data).toMatchObject({
    reason: "message_sent",
    data: {
      sourceId,
      assignment: "read",
      key: "focus",
      state: "pending",
      message: "Focus on a.ts first.",
      questionKey: null,
      doorbellFailure: null,
      acknowledgedAt: null,
      reply: null,
    },
  });
  expect(data.data.rungAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  // The doorbell is a fixed line that names the record, typed to the worker's agent name.
  expect(device.doorbells).toEqual([
    {
      name: device.launchName(launchId),
      text: "Operator recorded steering message focus for you.",
    },
  ]);
  // Within the period, a pending message adds no action.
  expect((await device.actions()).map((row) => row.action)).toEqual(["ready_assignment"]);
  const read = okValue(
    await fromWorker(() => WorkerQuestions.read({ paths: device.paths, key: "focus" })),
  );
  expect(read).toMatchObject({
    reason: "message_read",
    data: { state: "pending", message: "Focus on a.ts first." },
  });
  const acknowledged = okValue(
    await WorkerQuestions.acknowledge({ paths: device.paths, key: "focus", file: null }),
  );
  expect(acknowledged).toMatchObject({
    reason: "message_acknowledged",
    data: { state: "acknowledged", reply: null },
  });
  expect(acknowledged.data.acknowledgedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(
    await WorkerQuestions.acknowledge({ paths: device.paths, key: "focus", file: null }),
  ).toMatchObject({
    error: {
      reason: "message_not_open",
      detail: "Steering message focus of read is acknowledged. Nothing changed.",
    },
  });
  mock.restore();
  device.inPane(superPane);
  expect(await WorkerQuestions.close(selector(sourceId))).toMatchObject({
    error: { reason: "message_not_open" },
  });
});

test("a reply shows in next actions until the SuperAgent closes the message", async () => {
  const { sourceId } = await sent();
  const reply = await device.write("reply.md", "Done with a.ts, starting b.ts.\n");
  expect(
    okValue(
      await fromWorker(() =>
        WorkerQuestions.acknowledge({ paths: device.paths, key: "focus", file: reply }),
      ),
    ),
  ).toMatchObject({
    reason: "message_replied",
    data: { state: "replied", reply: "Done with a.ts, starting b.ts." },
  });
  mock.restore();
  const [first] = await device.actions();
  expect(first).toMatchObject({
    assignment: "read",
    action: "read_reply",
    reason: "message_replied",
    message: { key: "focus", reply: "Done with a.ts, starting b.ts." },
  });
  device.inPane(superPane);
  expect(okValue(await WorkerQuestions.close(selector(sourceId)))).toMatchObject({
    reason: "message_closed",
    data: { state: "closed", reply: "Done with a.ts, starting b.ts." },
  });
  mock.restore();
  expect((await device.actions()).map((row) => row.action)).toEqual(["ready_assignment"]);
});

test("a failed doorbell keeps the message pending as worker attention until a ring succeeds", async () => {
  const sourceId = await device.source();
  device.launch(sourceId);
  const file = await device.write("m.json", JSON.stringify({ key: "focus", message: "Stop." }));
  device.herdr.fails = true;
  device.inPane(superPane);
  expect(okValue(await WorkerQuestions.send({ ...selector(sourceId), file }))).toMatchObject({
    reason: "message_sent",
    data: { state: "pending", doorbellFailure: "herdr_failed: herdr agent exited 1: gone" },
  });
  mock.restore();
  expect((await device.actions())[0]).toMatchObject({
    action: "worker_attention",
    reason: "doorbell_failed",
    message: { key: "focus", doorbellFailure: "herdr_failed: herdr agent exited 1: gone" },
  });
  device.herdr.fails = false;
  device.inPane(superPane);
  expect(okValue(await WorkerQuestions.ring(selector(sourceId)))).toMatchObject({
    reason: "message_rung",
    data: { state: "pending", doorbellFailure: null },
  });
  mock.restore();
  expect(device.doorbells).toHaveLength(2);
  expect((await device.actions()).map((row) => row.action)).toEqual(["ready_assignment"]);
  // The SuperAgent can close a pending message that it no longer needs.
  device.inPane(superPane);
  expect(okValue(await WorkerQuestions.close(selector(sourceId)))).toMatchObject({
    data: { state: "closed" },
  });
  expect(await WorkerQuestions.ring(selector(sourceId))).toMatchObject({
    error: { reason: "message_not_open" },
  });
});

test("a doorbell records nothing on a message that ended while it rang", async () => {
  const sourceId = await device.source();
  device.launch(sourceId);
  const file = await device.write("m.json", JSON.stringify({ key: "focus", message: "Stop." }));
  device.inPane(superPane);
  // The SuperAgent closes the message while Herdr types its doorbell, and the doorbell fails.
  spyOn(Herdr, "prompt").mockImplementation(() =>
    fromSafePromise(async () => okValue(await WorkerQuestions.close(selector(sourceId)))).flatMap(
      () => Err({ reason: "herdr_failed" as const, detail: "herdr agent exited 1: gone" }),
    ),
  );
  expect(okValue(await WorkerQuestions.send({ ...selector(sourceId), file }))).toMatchObject({
    reason: "message_sent",
    data: { state: "closed", rungAt: null, doorbellFailure: null },
  });
});

test("an answer reaches the worker as a steering message, and the wait acknowledges it", async () => {
  const sourceId = await device.source();
  device.launch(sourceId);
  const question = await device.write(
    "q.json",
    JSON.stringify({ key: "scope", question: "Is b.ts in scope?" }),
  );
  okValue(await fromWorker(() => WorkerQuestions.ask({ paths: device.paths, file: question })));
  mock.restore();
  const answer = await device.write("answer.md", "No.");
  device.inPane(superPane);
  expect(
    okValue(
      await WorkerQuestions.answer({
        ...selector(sourceId, "scope"),
        by: "super-agent",
        file: answer,
        text: null,
      }),
    ),
  ).toMatchObject({
    reason: "question_answered",
    data: { state: "answered", message: "answer:scope", doorbellFailure: null },
  });
  expect(device.doorbells.map((row) => row.text)).toEqual([
    "Operator recorded steering message answer:scope for you.",
  ]);
  mock.restore();
  device.inPane(workerPane);
  expect(
    okValue(await WorkerQuestions.read({ paths: device.paths, key: "answer:scope" })),
  ).toMatchObject({ data: { state: "pending", message: "No.", questionKey: "scope" } });
  expect(
    okValue(await WorkerQuestions.wait({ paths: device.paths, key: "scope", timeoutSeconds: 0 })),
  ).toMatchObject({ reason: "question_answered" });
  expect(
    okValue(await WorkerQuestions.read({ paths: device.paths, key: "answer:scope" })),
  ).toMatchObject({ data: { state: "acknowledged" } });
  // A second wait reads the same answer and leaves the acknowledgement as it was.
  expect(
    okValue(await WorkerQuestions.wait({ paths: device.paths, key: "scope", timeoutSeconds: 0 })),
  ).toMatchObject({ reason: "question_answered" });
});

test("only the SuperAgent's pane steers, and only the worker's pane reads and acknowledges", async () => {
  const sourceId = await device.source();
  const file = await device.write("m.json", JSON.stringify({ key: "focus", message: "Stop." }));
  device.inPane(superPane);
  expect(await WorkerQuestions.send({ ...selector(sourceId), file })).toMatchObject({
    error: {
      reason: "assignment_not_running",
      detail: "Assignment read has no running worker launch. Nothing changed.",
    },
  });
  device.launch(sourceId);
  okValue(await WorkerQuestions.send({ ...selector(sourceId), file }));
  expect(await WorkerQuestions.send({ ...selector(sourceId), file })).toMatchObject({
    error: { reason: "message_key_taken" },
  });
  expect(await WorkerQuestions.ring({ ...selector(sourceId), key: "other" })).toMatchObject({
    error: { reason: "message_not_found" },
  });
  mock.restore();
  device.inPane(workerPane);
  for (const run of [
    () => WorkerQuestions.send({ ...selector(sourceId), file }),
    () => WorkerQuestions.ring(selector(sourceId)),
    () => WorkerQuestions.close(selector(sourceId)),
  ])
    expect(await run()).toMatchObject({ error: { reason: "self_steering_refused" } });
  expect(await WorkerQuestions.read({ paths: device.paths, key: "other" })).toMatchObject({
    error: {
      reason: "message_not_found",
      next: {
        decider: "super-agent",
        question: "Which recorded message key should this command target?",
      },
      state: { message: null },
      detail: "Assignment read has no steering message other. Nothing changed.",
    },
  });
  mock.restore();
  device.inPane(null);
  expect(await WorkerQuestions.read({ paths: device.paths, key: "focus" })).toMatchObject({
    error: { reason: "worker_pane_required" },
  });
  expect(
    await WorkerQuestions.acknowledge({ paths: device.paths, key: "focus", file: null }),
  ).toMatchObject({ error: { reason: "worker_pane_required" } });
});

test("an invalid draft or a missing file refuses and records nothing", async () => {
  const sourceId = await device.source();
  device.launch(sourceId);
  device.inPane(superPane);
  for (const content of ["{", JSON.stringify({ key: "answer:x", message: "Stop." })]) {
    const file = await device.write("bad.json", content);
    expect(await WorkerQuestions.send({ ...selector(sourceId), file })).toMatchObject({
      error: { reason: "invalid_message_input" },
    });
  }
  expect(
    await WorkerQuestions.send({ ...selector(sourceId), file: `${device.root}/missing.json` }),
  ).toMatchObject({ error: { reason: "message_io_failed" } });
  const file = await device.write("m.json", JSON.stringify({ key: "focus", message: "Stop." }));
  okValue(await WorkerQuestions.send({ ...selector(sourceId), file }));
  mock.restore();
  device.inPane(workerPane);
  const empty = await device.write("empty.md", " \n");
  expect(
    await WorkerQuestions.acknowledge({ paths: device.paths, key: "focus", file: empty }),
  ).toMatchObject({ error: { reason: "invalid_message_input" } });
  expect(okValue(await WorkerQuestions.read({ paths: device.paths, key: "focus" }))).toMatchObject({
    data: { state: "pending" },
  });
  expect(device.doorbells).toHaveLength(1);
});

test("a reset abandons the pending message, which then takes no acknowledgement", async () => {
  const { sourceId } = await sent();
  device.observe({ exited: true });
  okValue(
    await WorkSources.reset({
      paths: device.paths,
      cwd: device.checkout,
      sourceId,
      personInstructed: true,
    }),
  );
  device.inPane(superPane);
  expect(await WorkerQuestions.close(selector(sourceId))).toMatchObject({
    error: {
      reason: "message_not_open",
      detail: "Steering message focus of read is abandoned. Nothing changed.",
    },
  });
});
