import type { NextStep, ResultContext } from "../../lib/cli-result.ts";

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

const board: NextStep = {
  command: "operator next",
  why: "Read the current action before retrying this command.",
};
const ready: NextStep = {
  command: "operator ready",
  why: "Read and correct the device readiness blockers.",
};
const person: NextStep = {
  decider: "person",
  question: "May this command run on your explicit instruction?",
};
const steps: Record<string, NextStep> = {
  invalid_environment: {
    decider: "super-agent",
    question: "Which valid device environment should this command use?",
  },
  unsupported_bun: {
    decider: "super-agent",
    question: "Which supported Bun runtime should run this command?",
  },
  person_instruction_required: person,
  pr_not_open: {
    decider: "person",
    question: "How should the closed PR be handled before this review can continue?",
  },
  review_worktree_changed: {
    decider: "person",
    question: "Which work in the changed reviewer worktree must be kept?",
  },
  legacy_project_state: {
    decider: "person",
    question: "How should the legacy checkout be retired with its old release?",
  },
  self_decision_refused: {
    decider: "super-agent",
    question: "What is your decision from your own supervising pane?",
  },
  self_steering_refused: {
    decider: "super-agent",
    question: "What steering should the worker receive from your own supervising pane?",
  },
  source_supervised_elsewhere: {
    decider: "super-agent",
    question:
      "Will the recorded supervisor continue, or should the person authorize a source take-over?",
  },
  source_worker_running: {
    decider: "super-agent",
    question:
      "Should the active workers finish, or should their panes be closed before resetting the source?",
  },
  worker_pane_required: {
    decider: "super-agent",
    question: "Which dispatched worker pane must run this command?",
  },
  worker_launch_not_found: board,
  assignment_not_dispatchable: board,
  assignment_not_running: board,
  assignment_not_found: board,
  source_not_found: board,
  source_ended: board,
  source_not_open: board,
  source_parent_open: board,
  running_cap_reached: {
    command: "operator next --wait",
    why: "Wait for a running assignment to finish before dispatching more work.",
  },
  report_returned: {
    command: "operator report resume",
    why: "Read the returned report's follow-up before submitting again.",
  },
  report_awaiting_decision: {
    decider: "super-agent",
    question: "Does the submitted report meet the assignment, or must it be returned?",
  },
  report_not_submitted: board,
  report_not_returned: board,
  report_not_accepted: board,
  report_changed: board,
  assignment_not_report: {
    decider: "super-agent",
    question:
      "Which report assignment should this command target? The selected assignment completes through a PR.",
  },
  question_key_taken: {
    decider: "super-agent",
    question: "Which new key should identify this question?",
  },
  question_not_found: {
    decider: "super-agent",
    question: "Which recorded question key should this command target?",
  },
  question_not_open: board,
  message_key_taken: {
    decider: "super-agent",
    question: "Which new key should identify this steering message?",
  },
  message_not_found: {
    decider: "super-agent",
    question: "Which recorded message key should this command target?",
  },
  message_not_open: board,
  obligation_exists: {
    decider: "super-agent",
    question: "Which new key should identify this obligation?",
  },
  obligation_not_found: {
    decider: "super-agent",
    question: "Which recorded obligation key should this command target?",
  },
  obligation_not_open: { why: "The obligation is already closed. Nothing remains to close." },
  invalid_source_plan: {
    decider: "super-agent",
    question: "What corrected source plan should be supplied in --file?",
  },
  invalid_report_input: {
    decider: "super-agent",
    question: "What corrected report input should be supplied in --file?",
  },
  invalid_question_input: {
    decider: "super-agent",
    question: "What corrected question input should be supplied?",
  },
  invalid_message_input: {
    decider: "super-agent",
    question: "What corrected steering input should be supplied?",
  },
  invalid_obligation_input: {
    decider: "super-agent",
    question: "What corrected obligation input should be supplied in --file?",
  },
  source_profile_missing: {
    command: "operator config show",
    why: "Read the configured start profiles before correcting the plan.",
  },
  herdr_plugin_missing: {
    command: "operator herdr install",
    why: "Install the current release's Herdr plugin before dispatching.",
  },
  herdr_plugin_outdated: {
    command: "operator herdr install",
    why: "Update the Herdr plugin to the current release before dispatching.",
  },
  herdr_session_required: {
    decider: "super-agent",
    question: "Which Herdr session should run this command?",
  },
  herdr_session_mismatch: {
    decider: "super-agent",
    question: "Which recorded Herdr server must run this command?",
  },
  worker_not_ready: ready,
  project_not_registered: {
    command: "operator project register",
    why: "Register the controlling checkout explicitly before using it.",
  },
  controller_mismatch: {
    command: "operator project list",
    why: "Find the recorded controlling checkout and run the command there.",
  },
  controller_identity_mismatch: {
    decider: "super-agent",
    question: "How should the controlling checkout's recorded GitHub remote be restored?",
  },
  bare_repository: {
    decider: "super-agent",
    question: "Which non-bare controlling checkout should run this command?",
  },
  cleanup_unlanded_work: {
    decider: "person",
    question: "May the retained unlanded work be removed?",
  },
  cleanup_resource_mismatch: {
    decider: "person",
    question: "How should the resource that differs from its recorded identity be handled?",
  },
  cleanup_running: board,
  cleanup_not_allowed: board,
  internal_review_not_recorded: board,
  internal_review_ended: { why: "The internal review has already ended. No skip remains." },
  pr_worktree_missing: {
    decider: "person",
    question: "How should the missing PR worktree be recovered without losing unlanded work?",
  },
  promotion_worktree_missing: {
    decider: "super-agent",
    question:
      "Should the report be accepted without promotion and a new source registered instead?",
  },
  promotion_key_taken: {
    decider: "super-agent",
    question: "Which unused assignment key should the promotion plan use?",
  },
  adopt_branch_unavailable: {
    decider: "person",
    question:
      "How should local work or the checked-out adopted branch be preserved before adoption?",
  },
  adopt_branch_diverged: {
    decider: "person",
    question: "How should the diverged local and remote branches be preserved before adoption?",
  },
  adopt_pr_not_open: {
    decider: "super-agent",
    question: "Which open PR should the assignment adopt?",
  },
  adopt_pr_branch_mismatch: {
    decider: "super-agent",
    question: "Which assignment branch matches the adopted PR?",
  },
  parent_branch_unavailable: {
    decider: "super-agent",
    question: "Can the parent owner push its recorded branch before this dispatch is retried?",
  },
  launch_name_exhausted: {
    decider: "super-agent",
    question: "Which unused branch and worktree names should this assignment use?",
  },
  launch_failed: board,
  launch_interrupted: board,
  worktree_missing: {
    decider: "super-agent",
    question: "How should the recorded missing worktree be recovered?",
  },
  worktree_setup_failed: {
    decider: "super-agent",
    question: "How should the recorded worktree preparation failure be corrected before retrying?",
  },
  worktree_setup_unconfirmed: board,
  state_busy: {
    decider: "super-agent",
    question: "When has the active state operation finished so this command can be retried?",
  },
  state_missing: {
    command: "operator project register",
    why: "Register a project explicitly to initialize device state.",
  },
  state_corrupt: {
    decider: "person",
    question: "How should the damaged device state be recovered without overwriting it?",
  },
  state_incompatible: {
    decider: "person",
    question: "Which compatible Operator release should be used for this device state?",
  },
  state_migration_blocked: {
    decider: "super-agent",
    question: "How should the recorded live operations finish before the upgrade is retried?",
  },
};

/** Recovery never authorizes a transition or infers checked state from a reason or detail. */
export function decideRefusal(
  operation: string,
  reason: string,
  context: ResultContext,
): ResultContext {
  if (!operations.has(operation) || context.next !== undefined) return context;
  if (operation === "dispatch" && reason === "promotion_worktree_missing")
    return {
      ...context,
      next: {
        decider: "person",
        question:
          "How should the missing promoted worktree be recovered without losing unlanded work?",
      },
    };
  return {
    ...context,
    next: Object.hasOwn(steps, reason)
      ? steps[reason]
      : {
          decider: "super-agent",
          question: `How should ${reason} be corrected before retrying ${operation}?`,
        },
  };
}
