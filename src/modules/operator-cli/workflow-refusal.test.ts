import { expect, test } from "bun:test";
import { workflowRefusal } from "./workflow-refusal.ts";

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
