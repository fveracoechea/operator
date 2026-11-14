import { expect, test } from "bun:test";
import type { NextStep } from "../../lib/cli-result.ts";
import { withNext } from "./next.ts";

type Row = Parameters<typeof withNext>[1];
const assignment = { assignment: "read", reason: "assignment_ready" } as const;

const cases: { row: Row; next: NextStep }[] = [
  {
    row: { ...assignment, blockers: [], action: "ready_assignment" },
    next: {
      command: "operator dispatch --source source --assignment read",
      why: "The assignment is ready to start.",
    },
  },
  {
    row: { ...assignment, blockers: [], action: "replace_worker" },
    next: {
      command: "operator dispatch --source source --assignment read",
      why: "Replace the stopped worker without deleting its work.",
    },
  },
  {
    row: { ...assignment, blockers: [], action: "retry_handoff" },
    next: {
      command: "operator handoff --source source --assignment read",
      why: "Resume the internal review handoff.",
    },
  },
  {
    row: { ...assignment, blockers: [], action: "retry_cleanup" },
    next: {
      command: "operator cleanup --source source --assignment read",
      why: "Continue the recorded cleanup.",
    },
  },
  {
    row: { ...assignment, blockers: [], action: "retry_cleanup", report: {} },
    next: {
      command: "operator report accept --source source --assignment read",
      why: "Continue the recorded cleanup.",
    },
  },
  {
    row: { ...assignment, blockers: [], action: "retry_cleanup", report: undefined },
    next: {
      command: "operator cleanup --source source --assignment read",
      why: "Continue the recorded cleanup.",
    },
  },
  {
    row: { ...assignment, blockers: [], action: "review_report" },
    next: {
      decider: "super-agent",
      question: "Does the submitted report meet the assignment, or does it need follow-up?",
    },
  },
  {
    row: { ...assignment, blockers: [], action: "person_decision" },
    next: { decider: "person", question: "May the retained work or resource be removed?" },
  },
  ...(["worker_attention", "owner_attention", "resume_worker"] as const).map((action) => ({
    row: { ...assignment, blockers: [], action },
    next: {
      decider: "super-agent" as const,
      question: "What steering does the worker need for assignment_ready?",
    },
  })),
  {
    row: { ...assignment, blockers: [], action: "wait" },
    next: {
      command: "operator next --source source --wait",
      why: "Wait for the recorded blockers to change.",
    },
  },
  {
    row: { ...assignment, blockers: [], action: "ended" },
    next: { why: "No assignment work remains." },
  },
  {
    row: { action: "source_ended", reason: "finished", endedAt: null, prunableAt: null },
    next: { why: "No assignment work remains." },
  },
  {
    row: { action: "prune_source", reason: "retention_elapsed" },
    next: { command: "operator source prune", why: "The source retention period has elapsed." },
  },
];

test.each(cases)("next decision for $row.action preserves its row", ({ row, next }) => {
  const original = structuredClone(row);
  const expected: Row & { next: NextStep; command?: string } = { ...row, next };
  if (next.command !== undefined) expected.command = next.command;
  expect(withNext("source", row)).toStrictEqual(expected);
  expect(row).toStrictEqual(original);
});

test.each([
  { action: "answer_question", reason: "question_open", decider: "super-agent" },
  { action: "person_decision", reason: "question_awaiting_person", decider: "person" },
] as const)("$action names the question's decider", ({ action, reason, decider }) => {
  expect(
    withNext("source", {
      assignment: "read",
      action,
      reason,
      blockers: [],
      question: { key: "scope", question: "Is the parser in scope?", askedAt: "2026-11-13" },
    }),
  ).toMatchObject({ next: { decider, question: "Is the parser in scope?" } });
});

test("message replies quote source, assignment, and message keys independently", () => {
  expect(
    withNext("source's", {
      assignment: "read docs",
      action: "read_reply",
      reason: "message_replied",
      blockers: [],
      message: {
        key: "focus 'parser'",
        message: "Check the parser.",
        sentAt: "2026-11-13",
        questionKey: null,
        reply: "Checked.",
      },
    }),
  ).toMatchObject({
    command:
      "operator message close --source 'source'\\''s' --assignment 'read docs' --key 'focus '\\''parser'\\'''",
    next: {
      command:
        "operator message close --source 'source'\\''s' --assignment 'read docs' --key 'focus '\\''parser'\\'''",
      why: "Read the recorded reply and act on it before closing the message.",
    },
  });
});
