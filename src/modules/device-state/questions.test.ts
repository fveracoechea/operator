import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Err, Ok } from "unthrown";
import { deleteSourceRecords, readSources, resetSource } from "./sources.ts";
import { fixture, key, pane, running } from "./conversation-fixture.ts";
import { changeReport } from "./reports.ts";
import { changeQuestion, readQuestion, type QuestionRow } from "./questions.ts";
import { busy, reservedCopy } from "./state-fixture.ts";

function question(key: string, assignment = "read"): QuestionRow {
  return {
    sourceId: "s1",
    assignment,
    key,
    launchId: `l-${assignment}`,
    question: `Which ${key}?`,
    askedAt: "now",
    state: "open",
    answer: null,
    answeredBy: null,
    answeredAt: null,
    endedAt: null,
  };
}

function states(db: Database) {
  return db
    .query("SELECT assignment, key, state FROM worker_questions ORDER BY key, assignment")
    .all();
}

test("a worker pane and a SuperAgent selector read the same question by its key", () => {
  using db = fixture();
  expect(readQuestion(db, pane, "scope")).toMatchObject({
    error: { reason: "worker_launch_not_found" },
  });
  running(db);
  expect(readQuestion(db, pane, "scope")).toMatchObject({
    tag: "Ok",
    value: { assignment: { key: "read" }, launch: { id: "l-read" }, question: null },
  });
  expect(changeQuestion(db, pane, "scope", () => Ok({ insert: question("scope") }))).toMatchObject({
    tag: "Ok",
  });
  expect(readQuestion(db, key, "scope")).toMatchObject({
    value: { question: { key: "scope", state: "open", question: "Which scope?" } },
  });
  expect(readQuestion(db, { ...key, assignment: "missing" }, "scope")).toMatchObject({
    error: {
      reason: "assignment_not_found",
      next: {
        command: "operator next",
        why: "Read the available assignments before choosing a target.",
      },
      state: { sourceExists: true, assignmentExists: false },
    },
  });
  expect(readQuestion(db, { ...key, checkout: "/moved" }, "scope")).toMatchObject({
    error: { reason: "controller_mismatch" },
  });
});

test("a refused rule writes nothing, and an update changes only the question with its key", () => {
  using db = fixture();
  running(db);
  running(db, "other", "w1:p2");
  expect(
    changeQuestion(db, pane, "scope", () => Err({ reason: "refused", detail: "No." })),
  ).toMatchObject({ error: { reason: "refused" } });
  expect(states(db)).toEqual([]);
  changeQuestion(db, pane, "scope", () => Ok({ insert: question("scope") }));
  changeQuestion(db, pane, "name", () => Ok({ insert: question("name") }));
  changeQuestion(db, { ...pane, paneId: "w1:p2" }, "scope", () =>
    Ok({ insert: question("scope", "other") }),
  );
  expect(
    changeQuestion(db, key, "scope", (facts) => {
      expect(facts.question).toMatchObject({ key: "scope", state: "open" });
      return Ok({
        update: { state: "answered", answer: "All.", answeredBy: "person", answeredAt: "later" },
      });
    }),
  ).toMatchObject({ tag: "Ok", value: { facts: { question: { state: "open" } } } });
  expect(states(db)).toEqual([
    { assignment: "read", key: "name", state: "open" },
    { assignment: "other", key: "scope", state: "open" },
    { assignment: "read", key: "scope", state: "answered" },
  ]);
  expect(
    db.query("SELECT answer, answered_by FROM worker_questions WHERE state = 'answered'").get(),
  ).toEqual({ answer: "All.", answered_by: "person" });
});

test("accepting a report abandons its unanswered questions and keeps answered ones", () => {
  using db = fixture();
  running(db);
  running(db, "other", "w1:p2");
  changeQuestion(db, pane, "open", () => Ok({ insert: question("open") }));
  changeQuestion(db, pane, "person", () =>
    Ok({ insert: { ...question("person"), state: "awaiting_person" } }),
  );
  changeQuestion(db, pane, "done", () =>
    Ok({
      insert: {
        ...question("done"),
        state: "answered",
        answer: "Yes.",
        answeredBy: "super-agent",
        answeredAt: "now",
      },
    }),
  );
  changeQuestion(db, { ...pane, paneId: "w1:p2" }, "elsewhere", () =>
    Ok({ insert: question("elsewhere", "other") }),
  );
  // A submission leaves the assignment working, so its questions stay open.
  changeReport(db, pane, () => Ok({ assignmentState: "reported" }));
  expect(states(db)).toContainEqual({ assignment: "read", key: "open", state: "open" });
  changeReport(db, key, () => Ok({ assignmentState: "completed" }));
  expect(states(db)).toEqual([
    { assignment: "read", key: "done", state: "answered" },
    { assignment: "other", key: "elsewhere", state: "open" },
    { assignment: "read", key: "open", state: "abandoned" },
    { assignment: "read", key: "person", state: "abandoned" },
  ]);
  expect(
    db.query("SELECT key FROM worker_questions WHERE ended_at IS NOT NULL ORDER BY key").all(),
  ).toEqual([{ key: "open" }, { key: "person" }]);
});

test("a reset abandons the questions of abandoned assignments, and deletion removes them", () => {
  using db = fixture();
  running(db);
  running(db, "other", "w1:p2");
  changeQuestion(db, pane, "scope", () => Ok({ insert: question("scope") }));
  changeQuestion(db, { ...pane, paneId: "w1:p2" }, "kept", () =>
    Ok({ insert: question("kept", "other") }),
  );
  expect(
    resetSource(db, { repository: "owner/one", checkout: "/one", sourceId: "s1" }, () =>
      Ok({ abandon: ["read"] }),
    ),
  ).toMatchObject({ tag: "Ok" });
  expect(states(db)).toEqual([
    { assignment: "other", key: "kept", state: "open" },
    { assignment: "read", key: "scope", state: "abandoned" },
  ]);
  expect(readSources(db, "owner/one")).toMatchObject({
    value: [{ questions: [{ key: "kept" }, { key: "scope" }] }],
  });
  deleteSourceRecords(drizzle(db), ["s1"]);
  expect(states(db)).toEqual([]);
});

test("a question change reserves the writer first, and a read needs no reservation", () => {
  using db = fixture();
  running(db);
  using reserved = reservedCopy(db);
  expect(readQuestion(reserved.subject, pane, "scope")).toMatchObject({ tag: "Ok" });
  expect(
    changeQuestion(reserved.subject, pane, "scope", () => Err({ reason: "x", detail: "x" })),
  ).toMatchObject(busy);
});
