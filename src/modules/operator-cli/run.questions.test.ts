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
  trackerKey: "github:example/one#10",
  assignments: [
    {
      key: "investigate",
      trackerKey: "github:example/one#11",
      instructions: "Read the module and report the gaps. Ask the person about scope.",
      kind: "research",
      resources: "pane",
      dependencies: [],
    },
  ],
};

async function answerFile(text: string) {
  const file = `${device.root}/drafts/answer-${crypto.randomUUID()}.md`;
  await Bun.write(file, text, { createPath: true });
  return file;
}

test("a worker question stays in next actions until the SuperAgent answers it on the record", async () => {
  const source = await device.register({
    ...plan,
    assignments: [...plan.assignments, { ...plan.assignments[0], key: "other" }],
  });
  const worker = await device.dispatch(source, "investigate");
  const selector = ["--source", source, "--assignment", "investigate"];
  const pane = { pane: worker.paneId };
  const file = await answerFile("Is b.ts in scope?");

  // The worker asks from its own pane, and nothing types into the SuperAgent's pane.
  const asked = await device.run(["question", "ask", "--key", "scope", "--file", file], pane);
  expect(asked.code, asked.stderr).toBe(0);
  expect(asked.output).toMatchObject({
    operation: "question_ask",
    reason: "question_asked",
    data: { assignment: "investigate", key: "scope", state: "open" },
  });
  const askedAt = z.object({ data: z.object({ askedAt: z.string() }) }).parse(asked.output)
    .data.askedAt;

  // The worker ends its turn after it asks. Next shows the question, not an idle worker.
  await device.event("pane.agent_status_changed", {
    pane_id: worker.paneId,
    agent_status: "idle",
  });
  expect(await device.next("investigate")).toEqual([
    {
      assignment: "investigate",
      action: "answer_question",
      reason: "question_open",
      blockers: [],
      question: { key: "scope", question: "Is b.ts in scope?", askedAt },
      next: { decider: "super-agent", question: "Is b.ts in scope?" },
    },
  ]);

  // The instructions leave scope to the person, so the SuperAgent moves the question.
  expect(
    await device.run(["question", "escalate", ...selector, "--key", "scope"], pane),
  ).toMatchObject({ code: 4, output: { reason: "self_decision_refused" } });
  const escalated = await device.run(["question", "escalate", ...selector, "--key", "scope"]);
  expect(escalated.code, escalated.stderr).toBe(0);
  expect(await device.next("investigate")).toMatchObject([
    {
      action: "person_decision",
      reason: "question_awaiting_person",
      question: { key: "scope" },
      next: { decider: "person", question: "Is b.ts in scope?" },
    },
  ]);
  const notices = await Promise.all([
    device.run(["question", "wait", "--key", "scope", "--timeout", "0"], pane),
    device.run(["question", "wait", "--key", "scope", "--timeout", "0"], pane),
  ]);
  expect(notices.map((notice) => notice.output.reason).toSorted()).toEqual([
    "question_awaiting_person",
    "question_wait_timed_out",
  ]);
  for (const notice of notices)
    expect(notice.output.next).toMatchObject({ command: "operator question wait --key scope" });
  expect(
    await device.run(["question", "wait", "--key", "scope", "--timeout", "0"], pane),
  ).toMatchObject({
    code: 0,
    output: { reason: "question_wait_timed_out", data: { state: "awaiting_person" } },
  });

  const answered = await device.run([
    "question",
    "answer",
    ...selector,
    "--key",
    "scope",
    "--by",
    "person",
    "--file",
    await answerFile("No, only a.ts.\n"),
  ]);
  expect(answered.code, answered.stderr).toBe(0);
  expect(answered.output).toMatchObject({
    reason: "question_answered",
    data: { state: "answered", by: "person", answer: "No, only a.ts." },
  });
  expect(await device.next("investigate")).toMatchObject([
    { action: "worker_attention", reason: "worker_idle" },
  ]);

  // The worker reads the answer and who gave it from its own pane.
  expect(await device.run(["question", "wait", "--key", "scope"], pane)).toMatchObject({
    code: 0,
    output: {
      operation: "question_wait",
      reason: "question_answered",
      data: { answer: "No, only a.ts.", by: "person" },
    },
  });
  expect(
    await device.run(["question", "wait", "--key", "scope", "--timeout", "1000000"], pane),
  ).toMatchObject({
    code: 0,
    output: { reason: "question_answered", data: { by: "person" } },
  });
  expect(await device.herdrCalls()).not.toContain("pane send");
  for (const key of ["still-open", "withdrawn"]) {
    expect(
      (await device.run(["question", "ask", "--key", key, "--file", await answerFile(key)], pane))
        .code,
    ).toBe(0);
  }
  expect((await device.run(["question", "withdraw", "--key", "withdrawn"], pane)).code).toBe(0);
  const other = await device.dispatch(source, "other");
  expect(
    (
      await device.run(
        ["question", "ask", "--key", "other-scope", "--file", await answerFile("Other scope?")],
        { pane: other.paneId },
      )
    ).code,
  ).toBe(0);
  expect(
    (
      await device.run([
        "question",
        "answer",
        "--source",
        source,
        "--assignment",
        "other",
        "--key",
        "other-scope",
        "--by",
        "super-agent",
        "--file",
        await answerFile("Other answer."),
      ])
    ).code,
  ).toBe(0);
  await device.exec(["herdr", "pane", "exit", worker.paneId, "w1"], device.main);
  const replacement = await device.dispatch(source, "investigate");
  const brief = await Bun.file(replacement.brief).text();
  expect(brief).toContain(
    "## Questions answered for this assignment\n\n### `scope`\n\nBy: `person`",
  );
  expect(brief).toContain("> Is b.ts in scope?\n\nAnswer:\n\n> No, only a.ts.");
  expect(brief).toContain("Phase: `investigate`");
  expect(brief).not.toMatch(/still-open|withdrawn|other-scope|Other answer/);
}, 120000);

test("a SuperAgent answer needs its authority, and only the asking pane withdraws", async () => {
  const source = await device.register(plan);
  const worker = await device.dispatch(source, "investigate");
  const selector = ["--source", source, "--assignment", "investigate", "--key", "name"];
  const pane = { pane: worker.paneId };
  const file = await answerFile("Which name?");
  expect(await device.run(["question", "ask", "--key", "name", "--file", file])).toMatchObject({
    code: 4,
    output: { reason: "worker_launch_not_found" },
  });
  expect(
    await device.run(["question", "ask", "--key", "name", "--file", file], pane),
  ).toMatchObject({ code: 0 });
  expect(
    await device.run(["question", "ask", "--key", "name", "--file", file], pane),
  ).toMatchObject({
    code: 3,
    output: { reason: "question_key_taken" },
  });
  const text = await answerFile("Use reader.");
  expect(await device.run(["question", "answer", ...selector, "--file", text])).toMatchObject({
    code: 2,
  });
  expect(
    await device.run(["question", "answer", ...selector, "--by", "worker", "--file", text]),
  ).toMatchObject({ code: 2 });
  expect(await device.run(["question", "withdraw", "--key", "name"], pane)).toMatchObject({
    code: 0,
    output: { reason: "question_withdrawn", data: { state: "withdrawn" } },
  });
  expect(
    await device.run(["question", "answer", ...selector, "--by", "super-agent", "--file", text]),
  ).toMatchObject({ code: 3, output: { reason: "question_not_open" } });
}, 120000);
