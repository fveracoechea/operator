import { expect, test } from "bun:test";
import { decodeSource } from "./snapshot.ts";
import { storedLaunch, storedQuestion, storedSource } from "./source-fixture.ts";

const answered = {
  state: "answered",
  answer: "Yes.",
  answeredBy: "super-agent",
  answeredAt: "2026-01-04T00:00:00.000Z",
};
const ended = { endedAt: "2026-01-04T00:00:00.000Z" };

function source(state: string, questions: ReturnType<typeof storedQuestion>[]) {
  return storedSource([{ key: "read", completion: "report", state }], {
    launches: [storedLaunch("read")],
    questions,
  });
}

test("a stored question decodes with its state and the authority of its answer", () => {
  expect(
    decodeSource(
      source("running", [
        storedQuestion("read"),
        storedQuestion("read", { key: "done", ...answered, answeredBy: "person" }),
        storedQuestion("read", { key: "gone", state: "withdrawn", ...ended }),
      ]),
    ).questions,
  ).toMatchObject([
    { key: "scope", state: "open", answer: null },
    { key: "done", state: "answered", answeredBy: "person" },
    { key: "gone", state: "withdrawn" },
  ]);
  // An ended assignment keeps its answered and abandoned questions.
  expect(
    decodeSource(
      storedSource([{ key: "read", completion: "report", state: "abandoned" }], {
        state: "reset",
        endedAt: "later",
        launches: [storedLaunch("read", { state: "finished" })],
        questions: [
          storedQuestion("read", { state: "abandoned", ...ended }),
          storedQuestion("read", { key: "done", ...answered }),
        ],
      }),
    ).questions,
  ).toHaveLength(2);
});

test("an answer exists only on an answered question, and only an ended question has an end", () => {
  for (const question of [
    storedQuestion("read", { state: "answered" }),
    storedQuestion("read", { ...answered, answer: null }),
    storedQuestion("read", { ...answered, answeredBy: null }),
    storedQuestion("read", { ...answered, answeredAt: null }),
    storedQuestion("read", { ...answered, ...ended }),
    storedQuestion("read", { answer: "Early." }),
    storedQuestion("read", { answeredBy: "person" }),
    storedQuestion("read", { answeredAt: "now" }),
    storedQuestion("read", ended),
    storedQuestion("read", { state: "awaiting_person", ...ended }),
    storedQuestion("read", { state: "withdrawn" }),
    storedQuestion("read", { state: "abandoned" }),
    storedQuestion("read", { state: "asked" }),
    storedQuestion("read", { ...answered, answeredBy: "worker" }),
  ])
    expect(() => decodeSource(source("running", [question]))).toThrow();
});

function completed(question: ReturnType<typeof storedQuestion>) {
  return storedSource([{ key: "read", completion: "report", state: "completed" }], {
    state: "finished",
    endedAt: "later",
    launches: [storedLaunch("read", { state: "finished" })],
    questions: [question],
  });
}

test("a question belongs to a launch of its assignment, and an ended assignment answers none", () => {
  expect(() =>
    decodeSource(source("running", [storedQuestion("read", { launchId: "other" })])),
  ).toThrow();
  expect(() =>
    decodeSource(
      storedSource(
        [
          { key: "read", completion: "report", state: "running" },
          { key: "later", completion: "report", state: "running" },
        ],
        {
          launches: [storedLaunch("read"), storedLaunch("later")],
          questions: [storedQuestion("later", { launchId: "l-read" })],
        },
      ),
    ),
  ).toThrow();
  expect(decodeSource(completed(storedQuestion("read", answered))).questions).toHaveLength(1);
  for (const state of ["open", "awaiting_person"])
    expect(() => decodeSource(completed(storedQuestion("read", { state })))).toThrow();
});
