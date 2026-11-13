import { expect, test } from "bun:test";
import { decideQuestion, decideQuestionWait, type QuestionState } from "./question-machine.ts";

const workerPane = { socket: "/herdr.sock", paneId: "w1:p1" };
const superPane = { socket: "/herdr.sock", paneId: "super:p0" };

function facts(
  command: Parameters<typeof decideQuestion>[0]["command"],
  change: Partial<Parameters<typeof decideQuestion>[0]> = {},
) {
  return {
    command,
    assignment: { key: "read", state: "running" },
    launch: { id: "l1", state: "running", paneId: "w1:p1", herdrSocket: "/herdr.sock" },
    question: null,
    caller: superPane,
    ...change,
  };
}

function asked(state: QuestionState) {
  return { question: { key: "scope", state } };
}

test("a running worker asks a new key once for the whole assignment", () => {
  expect(decideQuestion(facts("ask", { caller: workerPane }))).toMatchObject({
    tag: "Ok",
    value: { insert: true, state: "open" },
  });
  for (const state of ["open", "answered", "withdrawn"] as const)
    expect(decideQuestion(facts("ask", { caller: workerPane, ...asked(state) }))).toMatchObject({
      tag: "Err",
      error: {
        reason: "question_key_taken",
        detail:
          "Assignment read already asked question scope. Ask with a new key. Nothing changed.",
      },
    });
});

test("an ask needs a running launch of an assignment that has not ended", () => {
  const refused = {
    tag: "Err",
    error: {
      reason: "assignment_not_running",
      detail: "Assignment read has no running worker launch. Nothing changed.",
    },
  };
  expect(decideQuestion(facts("ask", { launch: null }))).toMatchObject(refused);
  expect(
    decideQuestion(
      facts("ask", {
        launch: { id: "l1", state: "starting", paneId: null, herdrSocket: "/herdr.sock" },
      }),
    ),
  ).toMatchObject(refused);
  for (const state of ["merged", "completed", "abandoned"])
    expect(decideQuestion(facts("ask", { assignment: { key: "read", state } }))).toMatchObject(
      refused,
    );
  // A PR owner and a worker whose report waits for a decision can still ask.
  for (const state of ["pr-open", "reported"])
    expect(decideQuestion(facts("ask", { assignment: { key: "read", state } }))).toMatchObject({
      tag: "Ok",
    });
});

test("the SuperAgent answers an open question or one that waits on the person", () => {
  for (const state of ["open", "awaiting_person"] as const)
    expect(decideQuestion(facts("answer", asked(state)))).toMatchObject({
      tag: "Ok",
      value: { insert: false, state: "answered" },
    });
  for (const state of ["answered", "withdrawn", "abandoned"] as const)
    expect(decideQuestion(facts("answer", asked(state)))).toMatchObject({
      tag: "Err",
      error: {
        reason: "question_not_open",
        detail: `Question scope of read is ${state}. Nothing changed.`,
      },
    });
});

test("only an open question moves to the person", () => {
  expect(decideQuestion(facts("escalate", asked("open")))).toMatchObject({
    tag: "Ok",
    value: { insert: false, state: "awaiting_person" },
  });
  for (const state of ["awaiting_person", "answered", "withdrawn", "abandoned"] as const)
    expect(decideQuestion(facts("escalate", asked(state)))).toMatchObject({
      error: { reason: "question_not_open" },
    });
});

test("the worker withdraws an unanswered question", () => {
  for (const state of ["open", "awaiting_person"] as const)
    expect(
      decideQuestion(facts("withdraw", { caller: workerPane, ...asked(state) })),
    ).toMatchObject({
      tag: "Ok",
      value: { insert: false, state: "withdrawn" },
    });
  for (const state of ["answered", "withdrawn", "abandoned"] as const)
    expect(
      decideQuestion(facts("withdraw", { caller: workerPane, ...asked(state) })),
    ).toMatchObject({ error: { reason: "question_not_open" } });
});

test("a command on a key that was never asked names the missing question", () => {
  for (const command of ["answer", "escalate", "withdraw"] as const)
    expect(decideQuestion(facts(command))).toMatchObject({
      tag: "Err",
      error: {
        reason: "question_not_found",
        detail: "Assignment read has no question with this key. Nothing changed.",
      },
    });
});

test("the worker's own pane cannot answer or escalate, also on another server's same pane id", () => {
  const self = {
    tag: "Err",
    error: {
      reason: "self_decision_refused",
      detail:
        "A WorkerAgent cannot answer its own question. The supervising SuperAgent decides from its own pane. Nothing changed.",
    },
  };
  for (const command of ["answer", "escalate"] as const) {
    expect(decideQuestion(facts(command, { caller: workerPane, ...asked("open") }))).toMatchObject(
      self,
    );
    expect(
      decideQuestion(
        facts(command, { caller: { ...workerPane, socket: "/other.sock" }, ...asked("open") }),
      ),
    ).toMatchObject({ tag: "Ok" });
    // A launch with no recorded pane has no pane to decide from.
    expect(
      decideQuestion(
        facts(command, {
          caller: { socket: "/herdr.sock", paneId: null },
          launch: { id: "l1", state: "running", paneId: null, herdrSocket: "/herdr.sock" },
          ...asked("open"),
        }),
      ),
    ).toMatchObject({ tag: "Ok" });
  }
  expect(decideQuestion(facts("answer", { launch: null, ...asked("open") }))).toMatchObject({
    tag: "Ok",
  });
});

test("a wait returns an ended question at once and continues while the question waits", () => {
  for (const started of ["open", "awaiting_person"] as const) {
    expect(decideQuestionWait(started, "answered")).toBe("question_answered");
    expect(decideQuestionWait(started, "withdrawn")).toBe("question_withdrawn");
    expect(decideQuestionWait(started, "abandoned")).toBe("question_abandoned");
    expect(decideQuestionWait(started, "open")).toBeNull();
  }
  // Only the move to the person is news. A wait that started there keeps waiting.
  expect(decideQuestionWait("open", "awaiting_person")).toBe("question_awaiting_person");
  expect(decideQuestionWait("awaiting_person", "awaiting_person")).toBeNull();
});
