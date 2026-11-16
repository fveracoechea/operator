import type { ResultContext } from "../../lib/cli-result.ts";

/** An unclassified failure grants no retry; known recovery and facts come from its owner. */
export function workflowRefusal(
  operation: string,
  reason: string,
  context: Partial<ResultContext>,
): ResultContext {
  return {
    ...context,
    next: context.next ?? {
      decider: "super-agent",
      question: `How should ${reason} be corrected before retrying ${operation}?`,
    },
  };
}
