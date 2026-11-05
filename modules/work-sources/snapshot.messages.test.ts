import { expect, test } from "bun:test";
import { decodeSource } from "./snapshot.ts";
import { storedLaunch, storedMessage, storedSource } from "./source-fixture.ts";

const at = "2026-01-04T00:00:00.000Z";
const ended = { endedAt: at };

function source(state: string, messages: ReturnType<typeof storedMessage>[]) {
  return storedSource([{ key: "read", completion: "report", state }], {
    launches: [storedLaunch("read")],
    messages,
  });
}

test("a stored message decodes with its state, its acknowledgement, and its reply", () => {
  expect(
    decodeSource(
      source("running", [
        storedMessage("read"),
        storedMessage("read", { key: "seen", state: "acknowledged", acknowledgedAt: at, ...ended }),
        storedMessage("read", {
          key: "asked",
          state: "replied",
          acknowledgedAt: at,
          reply: "Yes.",
        }),
        storedMessage("read", {
          key: "done",
          state: "closed",
          acknowledgedAt: at,
          reply: "Yes.",
          ...ended,
        }),
        storedMessage("read", { key: "dropped", state: "closed", ...ended }),
        storedMessage("read", {
          key: "answer:scope",
          questionKey: "scope",
          doorbellFailure: "herdr_failed: x",
        }),
      ]),
    ).messages,
  ).toMatchObject([
    { key: "focus", state: "pending" },
    { key: "seen", state: "acknowledged" },
    { key: "asked", state: "replied", reply: "Yes." },
    { key: "done", state: "closed" },
    { key: "dropped", state: "closed" },
    { key: "answer:scope", questionKey: "scope" },
  ]);
});

test("only an acknowledgement has a time, only a reply has text, and only an end has an end", () => {
  for (const message of [
    storedMessage("read", ended),
    storedMessage("read", { acknowledgedAt: at }),
    storedMessage("read", { state: "replied", acknowledgedAt: at }),
    storedMessage("read", { state: "replied", acknowledgedAt: at, reply: "Yes.", ...ended }),
    storedMessage("read", { state: "acknowledged", ...ended }),
    storedMessage("read", { state: "acknowledged", acknowledgedAt: at }),
    storedMessage("read", { state: "acknowledged", acknowledgedAt: at, reply: "Yes.", ...ended }),
    storedMessage("read", { state: "closed", reply: "Yes.", ...ended }),
    storedMessage("read", { state: "closed" }),
    storedMessage("read", { state: "abandoned" }),
    storedMessage("read", { state: "sent" }),
  ])
    expect(() => decodeSource(source("running", [message]))).toThrow();
});

function finished(message: ReturnType<typeof storedMessage>) {
  return storedSource([{ key: "read", completion: "report", state: "completed" }], {
    state: "finished",
    endedAt: "later",
    launches: [storedLaunch("read", { state: "finished" })],
    messages: [message],
  });
}

test("a message belongs to a launch of its assignment, and an ended assignment leaves none open", () => {
  expect(() =>
    decodeSource(source("running", [storedMessage("read", { launchId: "other" })])),
  ).toThrow();
  expect(() => decodeSource(finished(storedMessage("read")))).toThrow();
  expect(() =>
    decodeSource(
      finished(storedMessage("read", { state: "replied", acknowledgedAt: at, reply: "Yes." })),
    ),
  ).toThrow();
  expect(
    decodeSource(finished(storedMessage("read", { state: "abandoned", ...ended }))).messages,
  ).toHaveLength(1);
});
