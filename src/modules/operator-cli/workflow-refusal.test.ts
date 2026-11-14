import { expect, test } from "bun:test";
import { workflowRefusal } from "./workflow-refusal.ts";
import { expectRefusalContext } from "../../lib/cli-result-fixture.ts";

test.each([
  "workflow_startup",
  "dispatch",
  "next",
  "next_wait",
  "cleanup",
  "internal_review_skip",
  "source_register",
  "source_show",
  "source_reset",
  "source_take_over",
  "source_prune",
  "report_submit",
  "report_resume",
  "report_accept",
  "report_return",
  "question_ask",
  "question_wait",
  "question_withdraw",
  "question_escalate",
  "question_answer",
  "message_send",
  "message_ring",
  "message_close",
  "message_read",
  "message_ack",
  "obligation_add",
  "obligation_close",
  "obligation_list",
])(
  "an unclassified %s refusal names a supervisor decision without inventing state",
  (operation) => {
    const result = workflowRefusal(operation, "unclassified", {});
    expectRefusalContext({ ...result, reason: "unclassified" });
    expect(result).toMatchObject({ next: { decider: "super-agent" } });
    expect(result).not.toHaveProperty("state");
  },
);

test("an unclassified workflow failure asks its supervisor without inferring state or retrying an effect", () => {
  expect(workflowRefusal("dispatch", "host_session_failed", {})).toEqual({
    next: {
      decider: "super-agent",
      question: "How should host_session_failed be corrected before retrying dispatch?",
    },
  });
  expect(workflowRefusal("message_read", "toString", { state: { checked: false } })).toEqual({
    state: { checked: false },
    next: {
      decider: "super-agent",
      question: "How should toString be corrected before retrying message_read?",
    },
  });
});

test("formatting preserves an owner's recovery and does not migrate other command families", () => {
  const context = {
    next: { decider: "person" as const, question: "May retained work be removed?" },
    state: { changed: true },
  };
  expect(workflowRefusal("cleanup", "cleanup_unlanded_work", context)).toBe(context);
  const untouched = {};
  expect(workflowRefusal("pr_associate", "pr_not_open", untouched)).toBe(untouched);
});
