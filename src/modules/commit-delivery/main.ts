import { Workflow } from "./workflow.ts";

/** Commit delivery keeps its effect protocol private to this module. */
export const CommitDelivery = {
  initialize(input: Parameters<typeof Workflow.initialize>[0]) {
    return Workflow.initialize(input);
  },
  review(input: Parameters<typeof Workflow.review>[0]) {
    return Workflow.review(input);
  },
  round(input: Parameters<typeof Workflow.round>[0]) {
    return Workflow.round(input);
  },
  deliver(input: Parameters<typeof Workflow.deliver>[0]) {
    return Workflow.deliver(input);
  },
};
