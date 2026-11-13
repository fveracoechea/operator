import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import { z } from "zod";
import { workerDevice } from "./worker-fixture.ts";

let device: Awaited<ReturnType<typeof workerDevice>>;
beforeEach(async () => {
  device = await workerDevice();
});
afterEach(async () => {
  await rm(device.root, { recursive: true, force: true });
});

const plan = {
  trackerKey: "github:example/one#20",
  assignments: [
    {
      key: "investigate",
      trackerKey: "github:example/one#21",
      instructions: "Read the module and report the gaps.",
      kind: "research",
      resources: "pane",
      dependencies: [],
    },
  ],
};

/** The text of each `herdr agent prompt` call after dispatch's brief prompt. */
async function prompts() {
  const calls = (await Bun.file(`${device.root}/herdr-calls.jsonl`).text()).trim().split("\n");
  return calls
    .map((line) => z.array(z.string()).parse(JSON.parse(line)))
    .filter((args) => args[0] === "agent" && args[1] === "prompt")
    .map((args) => args[3])
    .slice(1);
}

test("a steering message reaches the worker as a doorbell and returns as a recorded reply", async () => {
  const source = await device.register(plan);
  const worker = await device.dispatch(source, "investigate");
  const selector = ["--source", source, "--assignment", "investigate"];
  const pane = { pane: worker.paneId };
  const file = await device.writeJson("focus.json", {
    key: "focus",
    message: "Report the gaps in a.ts first.",
  });

  expect(await device.run(["message", "send", ...selector, "--file", file], pane)).toMatchObject({
    code: 4,
    output: { reason: "self_steering_refused" },
  });
  const sent = await device.run(["message", "send", ...selector, "--file", file]);
  expect(sent.code, sent.stderr).toBe(0);
  expect(sent.output).toMatchObject({
    operation: "message_send",
    reason: "message_sent",
    data: { key: "focus", state: "pending", doorbellFailure: null },
  });
  // The doorbell names the record and carries none of the message text.
  expect(await prompts()).toEqual(["Operator recorded steering message focus for you."]);

  expect(await device.run(["message", "read", "--key", "focus"], pane)).toMatchObject({
    code: 0,
    output: { reason: "message_read", data: { message: "Report the gaps in a.ts first." } },
  });
  const reply = `${device.root}/drafts/reply.md`;
  await Bun.write(reply, "a.ts has two gaps; b.ts next.\n");
  expect(
    await device.run(["message", "ack", "--key", "focus", "--file", reply], pane),
  ).toMatchObject({ code: 0, output: { reason: "message_replied", data: { state: "replied" } } });
  // The reply waits on the SuperAgent beside the working worker's own wait.
  expect((await device.next("investigate"))[0]).toMatchObject({
    action: "read_reply",
    command: `operator message close --source ${source} --assignment investigate --key focus`,
    next: {
      command: `operator message close --source ${source} --assignment investigate --key focus`,
      why: "Read the recorded reply and act on it before closing the message.",
    },
    reason: "message_replied",
    message: { key: "focus", reply: "a.ts has two gaps; b.ts next." },
  });
  expect(await device.run(["message", "close", ...selector, "--key", "focus"])).toMatchObject({
    code: 0,
    output: { reason: "message_closed", data: { state: "closed" } },
  });
  expect(await device.herdrCalls()).not.toContain("pane send");
}, 120000);

test("an answer rings the worker's doorbell, and the worker's wait reads it", async () => {
  const source = await device.register(plan);
  const worker = await device.dispatch(source, "investigate");
  const pane = { pane: worker.paneId };
  const question = await device.writeJson("q.json", { key: "scope", question: "b.ts too?" });
  expect(await device.run(["question", "ask", "--file", question], pane)).toMatchObject({
    code: 0,
  });
  const answer = `${device.root}/drafts/answer.md`;
  await Bun.write(answer, "No.\n");
  const answered = await device.run([
    "question",
    "answer",
    "--source",
    source,
    "--assignment",
    "investigate",
    "--key",
    "scope",
    "--by",
    "super-agent",
    "--file",
    answer,
  ]);
  expect(answered.code, answered.stderr).toBe(0);
  expect(answered.output).toMatchObject({ data: { message: "answer:scope" } });
  expect(await prompts()).toEqual(["Operator recorded steering message answer:scope for you."]);
  expect(
    await device.run(["question", "wait", "--key", "scope", "--timeout", "0"], pane),
  ).toMatchObject({ code: 0, output: { reason: "question_answered" } });
  expect(await device.run(["message", "read", "--key", "answer:scope"], pane)).toMatchObject({
    output: { data: { state: "acknowledged", message: "No." } },
  });
}, 120000);

test("a steering message and an answer can be sent as text, with no file", async () => {
  const source = await device.register(plan);
  const worker = await device.dispatch(source, "investigate");
  const selector = ["--source", source, "--assignment", "investigate"];
  const pane = { pane: worker.paneId };
  // Plain text that is not JSON is the message itself.
  const text = 'Say "done" when a.ts passes.';

  const sent = await device.run(["message", "send", ...selector, "--key", "focus", "--text", text]);
  expect(sent.code, sent.stderr).toBe(0);
  expect(sent.output).toMatchObject({ reason: "message_sent", data: { key: "focus" } });
  expect(await device.run(["message", "read", "--key", "focus"], pane)).toMatchObject({
    output: { data: { message: text } },
  });
  const file = await device.writeJson("other.json", { key: "other", message: "Stop." });
  for (const flags of [
    ["--text", text],
    ["--key", "other", "--file", file],
    ["--key", "other", "--file", file, "--text", text],
  ])
    expect(await device.run(["message", "send", ...selector, ...flags])).toMatchObject({ code: 2 });

  const question = await device.writeJson("q.json", { key: "scope", question: "b.ts too?" });
  expect(await device.run(["question", "ask", "--file", question], pane)).toMatchObject({
    code: 0,
  });
  const answer = [...selector, "--key", "scope", "--by", "super-agent"];
  expect(
    await device.run(["question", "answer", ...answer, "--file", file, "--text", "No."]),
  ).toMatchObject({ code: 2 });
  const answered = await device.run(["question", "answer", ...answer, "--text", "No."]);
  expect(answered.code, answered.stderr).toBe(0);
  expect(answered.output).toMatchObject({
    reason: "question_answered",
    data: { answer: "No.", message: "answer:scope" },
  });
}, 120000);
