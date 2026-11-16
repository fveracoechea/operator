import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Err, Ok } from "unthrown";
import { deleteSourceRecords, readSources, resetSource } from "./sources.ts";
import { changeReport } from "./reports.ts";
import { changeMessage, readMessage, type MessageRow } from "./messages.ts";
import { changeQuestion } from "./questions.ts";
import { fixture, key, pane, running } from "./conversation-fixture.ts";
import { busy, reservedCopy } from "./state-fixture.ts";

function message(name: string, assignment = "read", state = "pending"): MessageRow {
  return {
    sourceId: "s1",
    assignment,
    key: name,
    launchId: `l-${assignment}`,
    message: `Do ${name}.`,
    questionKey: null,
    sentAt: "now",
    state,
    rungAt: null,
    doorbellFailure: null,
    acknowledgedAt: null,
    reply: null,
    endedAt: null,
  };
}

function states(db: Database) {
  return db
    .query("SELECT assignment, key, state FROM worker_messages ORDER BY key, assignment")
    .all();
}

test("a SuperAgent selector and the worker pane read the same message by its key", () => {
  using db = fixture();
  running(db);
  expect(readMessage(db, key, "focus")).toMatchObject({
    tag: "Ok",
    value: { assignment: { key: "read" }, launch: { id: "l-read" }, message: null },
  });
  expect(changeMessage(db, key, "focus", () => Ok({ insert: message("focus") }))).toMatchObject({
    tag: "Ok",
  });
  expect(readMessage(db, pane, "focus")).toMatchObject({
    value: { message: { key: "focus", state: "pending", message: "Do focus." } },
  });
  expect(readMessage(db, { ...key, assignment: "missing" }, "focus")).toMatchObject({
    error: {
      reason: "assignment_not_found",
      next: {
        command: "operator next",
        why: "Read the available assignments before choosing a target.",
      },
      state: { sourceExists: true, assignmentExists: false },
    },
  });
});

test("a refused rule writes nothing, and an update changes only the message with its key", () => {
  using db = fixture();
  running(db);
  running(db, "other", "w1:p2");
  expect(
    changeMessage(db, key, "focus", () => Err({ reason: "refused", detail: "No." })),
  ).toMatchObject({ error: { reason: "refused" } });
  expect(states(db)).toEqual([]);
  changeMessage(db, key, "focus", () => Ok({ insert: message("focus") }));
  changeMessage(db, key, "stop", () => Ok({ insert: message("stop") }));
  changeMessage(db, { ...key, assignment: "other" }, "focus", () =>
    Ok({ insert: message("focus", "other") }),
  );
  changeMessage(db, pane, "focus", () =>
    Ok({ update: { state: "replied", acknowledgedAt: "later", reply: "Yes." } }),
  );
  expect(states(db)).toEqual([
    { assignment: "other", key: "focus", state: "pending" },
    { assignment: "read", key: "focus", state: "replied" },
    { assignment: "read", key: "stop", state: "pending" },
  ]);
});

test("an answer records its steering message in the same transaction", () => {
  using db = fixture();
  running(db);
  changeQuestion(db, pane, "scope", () =>
    Ok({
      insert: {
        sourceId: "s1",
        assignment: "read",
        key: "scope",
        launchId: "l-read",
        question: "Which?",
        askedAt: "now",
        state: "open",
        answer: null,
        answeredBy: null,
        answeredAt: null,
        endedAt: null,
      },
    }),
  );
  expect(
    changeQuestion(db, key, "scope", () => Err({ reason: "refused", detail: "No." })),
  ).toMatchObject({ tag: "Err" });
  expect(states(db)).toEqual([]);
  changeQuestion(db, key, "scope", () =>
    Ok({
      update: { state: "answered", answer: "All.", answeredBy: "person", answeredAt: "later" },
      message: { ...message("answer:scope"), message: "All.", questionKey: "scope" },
    }),
  );
  expect(readMessage(db, pane, "answer:scope")).toMatchObject({
    value: { message: { state: "pending", message: "All.", questionKey: "scope" } },
  });
});

test("an ended assignment abandons its pending and replied messages and keeps the others", () => {
  using db = fixture();
  running(db);
  running(db, "other", "w1:p2");
  changeMessage(db, key, "pending", () => Ok({ insert: message("pending") }));
  changeMessage(db, key, "replied", () => Ok({ insert: message("replied", "read", "replied") }));
  changeMessage(db, key, "seen", () =>
    Ok({ insert: { ...message("seen", "read", "acknowledged"), endedAt: "now" } }),
  );
  changeMessage(db, { ...key, assignment: "other" }, "elsewhere", () =>
    Ok({ insert: message("elsewhere", "other") }),
  );
  changeReport(db, key, () => Ok({ assignmentState: "completed" }));
  expect(states(db)).toEqual([
    { assignment: "other", key: "elsewhere", state: "pending" },
    { assignment: "read", key: "pending", state: "abandoned" },
    { assignment: "read", key: "replied", state: "abandoned" },
    { assignment: "read", key: "seen", state: "acknowledged" },
  ]);
  expect(
    db.query("SELECT key FROM worker_messages WHERE ended_at IS NOT NULL ORDER BY key").all(),
  ).toEqual([{ key: "pending" }, { key: "replied" }, { key: "seen" }]);
});

test("a reset abandons the messages of abandoned assignments, and deletion removes them", () => {
  using db = fixture();
  running(db);
  changeMessage(db, key, "focus", () => Ok({ insert: message("focus") }));
  resetSource(db, { repository: "owner/one", checkout: "/one", sourceId: "s1" }, () =>
    Ok({ abandon: ["read"] }),
  );
  expect(states(db)).toEqual([{ assignment: "read", key: "focus", state: "abandoned" }]);
  expect(readSources(db, "owner/one")).toMatchObject({
    value: [{ messages: [{ key: "focus", state: "abandoned" }] }],
  });
  deleteSourceRecords(drizzle(db), ["s1"]);
  expect(states(db)).toEqual([]);
});

test("a message change reserves the writer first, and a read needs no reservation", () => {
  using db = fixture();
  running(db);
  using reserved = reservedCopy(db);
  expect(readMessage(reserved.subject, key, "focus")).toMatchObject({ tag: "Ok" });
  expect(
    changeMessage(reserved.subject, key, "focus", () => Err({ reason: "x", detail: "x" })),
  ).toMatchObject(busy);
});
