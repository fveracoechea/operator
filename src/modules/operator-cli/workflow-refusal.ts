import type { ResultContext } from "../../lib/cli-result.ts";

const operations = new Set([
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
]);

/** An unclassified failure grants no retry; known recovery and facts come from its owner. */
export function workflowRefusal(
  operation: string,
  reason: string,
  context: ResultContext,
): ResultContext {
  if (!operations.has(operation) || context.next !== undefined) return context;
  return {
    ...context,
    next: {
      decider: "super-agent",
      question: `How should ${reason} be corrected before retrying ${operation}?`,
    },
  };
}
