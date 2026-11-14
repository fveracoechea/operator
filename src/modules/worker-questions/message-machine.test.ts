import { expect, test } from "bun:test";
import { decideMessage as messageDecision, type MessageState } from "./message-machine.ts";
import { expectRefusalContext } from "../../lib/cli-result-fixture.ts";

function decideMessage(...args: Parameters<typeof messageDecision>) {
  const result = messageDecision(...args);
  if (result.tag === "Err") expectRefusalContext(result.error);
  return result;
}

const workerPane = { socket: "/herdr.sock", paneId: "w1:p1" };
const superPane = { socket: "/herdr.sock", paneId: "super:p0" };

function facts(
  command: Parameters<typeof decideMessage>[0]["command"],
  change: Partial<Parameters<typeof decideMessage>[0]> = {},
) {
  return {
    command,
    assignment: { key: "read", state: "running" },
    launch: { id: "l1", state: "running", paneId: "w1:p1", herdrSocket: "/herdr.sock" },
    message: null,
    reply: false,
    caller: superPane,
    ...change,
  };
}

function sent(state: MessageState) {
  return { message: { key: "focus", state } };
}

const notRunning = {
  tag: "Err",
  error: {
    reason: "assignment_not_running",
    next: { command: "operator next" },
    detail: "Assignment read has no running worker launch. Nothing changed.",
  },
};

test("the SuperAgent sends a new key once to a running worker", () => {
  expect(decideMessage(facts("send"))).toMatchObject({
    tag: "Ok",
    value: { insert: true, state: "pending" },
  });
  for (const state of ["pending", "acknowledged", "closed"] as const)
    expect(decideMessage(facts("send", sent(state)))).toMatchObject({
      error: {
        reason: "message_key_taken",
        next: {
          decider: "super-agent",
          question: "Which new key should identify this steering message?",
        },
        state: { messageExists: true },
        detail:
          "Assignment read already has steering message focus. Send with a new key. Nothing changed.",
      },
    });
  expect(decideMessage(facts("send", { launch: null }))).toMatchObject({
    ...notRunning,
    error: { ...notRunning.error, state: { assignment: "running", launch: null } },
  });
  expect(
    decideMessage(
      facts("send", {
        launch: { id: "l1", state: "starting", paneId: null, herdrSocket: "/herdr.sock" },
      }),
    ),
  ).toMatchObject(notRunning);
  for (const state of ["merged", "completed", "abandoned"])
    expect(decideMessage(facts("send", { assignment: { key: "read", state } }))).toMatchObject(
      notRunning,
    );
});

test("a ring needs a pending message of a running worker", () => {
  expect(decideMessage(facts("ring", sent("pending")))).toMatchObject({
    tag: "Ok",
    value: { insert: false, state: "pending" },
  });
  expect(decideMessage(facts("ring", { ...sent("pending"), launch: null }))).toMatchObject(
    notRunning,
  );
  expect(decideMessage(facts("ring"))).toMatchObject({
    error: {
      reason: "message_not_found",
      next: {
        decider: "super-agent",
        question: "Which recorded message key should this command target?",
      },
      state: { message: null },
      detail: "Assignment read has no steering message with this key. Nothing changed.",
    },
  });
  for (const state of ["acknowledged", "replied", "closed", "abandoned"] as const)
    expect(decideMessage(facts("ring", sent(state)))).toMatchObject({
      error: {
        reason: "message_not_open",
        next: { command: "operator next" },
        state: { message: state },
        detail: `Steering message focus of read is ${state}. Nothing changed.`,
      },
    });
});

test("the worker acknowledges a pending message, and a reply keeps it open", () => {
  const worker = { caller: workerPane, ...sent("pending") };
  expect(decideMessage(facts("acknowledge", worker))).toMatchObject({
    tag: "Ok",
    value: { insert: false, state: "acknowledged" },
  });
  expect(decideMessage(facts("acknowledge", { ...worker, reply: true }))).toMatchObject({
    tag: "Ok",
    value: { insert: false, state: "replied" },
  });
  for (const state of ["acknowledged", "replied", "closed", "abandoned"] as const)
    expect(
      decideMessage(facts("acknowledge", { caller: workerPane, ...sent(state) })),
    ).toMatchObject({ error: { reason: "message_not_open" } });
});

test("the SuperAgent closes a pending or replied message", () => {
  for (const state of ["pending", "replied"] as const)
    expect(decideMessage(facts("close", sent(state)))).toMatchObject({
      tag: "Ok",
      value: { insert: false, state: "closed" },
    });
  for (const state of ["acknowledged", "closed", "abandoned"] as const)
    expect(decideMessage(facts("close", sent(state)))).toMatchObject({
      error: { reason: "message_not_open" },
    });
});

test("the worker's own pane cannot send, ring, or close", () => {
  for (const command of ["send", "ring", "close"] as const)
    expect(decideMessage(facts(command, { caller: workerPane, ...sent("pending") }))).toMatchObject(
      {
        tag: "Err",
        error: {
          reason: "self_steering_refused",
          next: {
            decider: "super-agent",
            question: "What steering should the worker receive from your own supervising pane?",
          },
          state: { samePane: true, sameServer: true },
          detail:
            "A WorkerAgent cannot steer its own assignment. The supervising SuperAgent sends from its own pane. Nothing changed.",
        },
      },
    );
  // Another socket with the same pane identifier is another pane.
  expect(
    decideMessage(facts("send", { caller: { socket: "/other.sock", paneId: "w1:p1" } })),
  ).toMatchObject({ tag: "Ok" });
  // A launch with no pane yet has no worker pane to refuse.
  expect(
    decideMessage(
      facts("close", {
        ...sent("pending"),
        caller: { socket: "/herdr.sock", paneId: null },
        launch: { id: "l1", state: "running", paneId: null, herdrSocket: "/herdr.sock" },
      }),
    ),
  ).toMatchObject({ tag: "Ok" });
});
