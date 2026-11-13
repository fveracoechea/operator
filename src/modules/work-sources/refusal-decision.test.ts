import { expect, test } from "bun:test";
import { decideRefusal as workflowRefusal } from "./refusal-decision.ts";

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
])("%s is covered by the refusal migration", (operation) => {
  expect(workflowRefusal(operation, "person_instruction_required", {})).toEqual({
    next: { decider: "person", question: "May this command run on your explicit instruction?" },
  });
});

test.each([
  "worker_launch_not_found",
  "assignment_not_dispatchable",
  "assignment_not_running",
  "assignment_not_found",
  "source_not_found",
  "source_ended",
  "source_not_open",
  "source_parent_open",
  "report_not_submitted",
  "report_not_returned",
  "report_not_accepted",
  "report_changed",
  "question_not_open",
  "message_not_open",
  "cleanup_running",
  "cleanup_not_allowed",
  "internal_review_not_recorded",
  "launch_failed",
  "launch_interrupted",
  "worktree_setup_unconfirmed",
])("%s requires reading the current workflow action", (reason) => {
  expect(workflowRefusal("dispatch", reason, {})).toEqual({
    next: {
      command: "operator next",
      why: "Read the current action before retrying this command.",
    },
  });
});

test.each([
  [
    "source_profile_missing",
    "operator config show",
    "Read the configured start profiles before correcting the plan.",
  ],
  [
    "herdr_plugin_outdated",
    "operator herdr install",
    "Update the Herdr plugin to the current release before dispatching.",
  ],
  ["worker_not_ready", "operator ready", "Read and correct the device readiness blockers."],
  [
    "project_not_registered",
    "operator project register",
    "Register the controlling checkout explicitly before using it.",
  ],
  [
    "controller_mismatch",
    "operator project list",
    "Find the recorded controlling checkout and run the command there.",
  ],
  [
    "state_missing",
    "operator project register",
    "Register a project explicitly to initialize device state.",
  ],
])("%s names the available repair command", (reason, command, why) => {
  expect(workflowRefusal("source_register", reason, {})).toEqual({ next: { command, why } });
});

test.each([
  ["invalid_environment", "super-agent", "Which valid device environment should this command use?"],
  ["unsupported_bun", "super-agent", "Which supported Bun runtime should run this command?"],
  [
    "legacy_project_state",
    "person",
    "How should the legacy checkout be retired with its old release?",
  ],
  [
    "source_supervised_elsewhere",
    "super-agent",
    "Will the recorded supervisor continue, or should the person authorize a source take-over?",
  ],
  [
    "source_worker_running",
    "super-agent",
    "Should the active workers finish, or should their panes be closed before resetting the source?",
  ],
  ["worker_pane_required", "super-agent", "Which dispatched worker pane must run this command?"],
  [
    "report_awaiting_decision",
    "super-agent",
    "Does the submitted report meet the assignment, or must it be returned?",
  ],
  [
    "assignment_not_report",
    "super-agent",
    "Which report assignment should this command target? The selected assignment completes through a PR.",
  ],
  ["question_not_found", "super-agent", "Which recorded question key should this command target?"],
  ["message_key_taken", "super-agent", "Which new key should identify this steering message?"],
  ["message_not_found", "super-agent", "Which recorded message key should this command target?"],
  [
    "obligation_not_found",
    "super-agent",
    "Which recorded obligation key should this command target?",
  ],
  [
    "invalid_source_plan",
    "super-agent",
    "What corrected source plan should be supplied in --file?",
  ],
  [
    "invalid_report_input",
    "super-agent",
    "What corrected report input should be supplied in --file?",
  ],
  ["invalid_question_input", "super-agent", "What corrected question input should be supplied?"],
  ["invalid_message_input", "super-agent", "What corrected steering input should be supplied?"],
  [
    "invalid_obligation_input",
    "super-agent",
    "What corrected obligation input should be supplied in --file?",
  ],
  ["herdr_session_required", "super-agent", "Which Herdr session should run this command?"],
  ["herdr_session_mismatch", "super-agent", "Which recorded Herdr server must run this command?"],
  [
    "controller_identity_mismatch",
    "super-agent",
    "How should the controlling checkout's recorded GitHub remote be restored?",
  ],
  [
    "bare_repository",
    "super-agent",
    "Which non-bare controlling checkout should run this command?",
  ],
  [
    "cleanup_resource_mismatch",
    "person",
    "How should the resource that differs from its recorded identity be handled?",
  ],
  [
    "pr_worktree_missing",
    "person",
    "How should the missing PR worktree be recovered without losing unlanded work?",
  ],
  [
    "promotion_worktree_missing",
    "super-agent",
    "Should the report be accepted without promotion and a new source registered instead?",
  ],
  [
    "promotion_key_taken",
    "super-agent",
    "Which unused assignment key should the promotion plan use?",
  ],
  [
    "adopt_branch_unavailable",
    "person",
    "How should local work or the checked-out adopted branch be preserved before adoption?",
  ],
  [
    "adopt_branch_diverged",
    "person",
    "How should the diverged local and remote branches be preserved before adoption?",
  ],
  ["adopt_pr_not_open", "super-agent", "Which open PR should the assignment adopt?"],
  ["adopt_pr_branch_mismatch", "super-agent", "Which assignment branch matches the adopted PR?"],
  [
    "parent_branch_unavailable",
    "super-agent",
    "Can the parent owner push its recorded branch before this dispatch is retried?",
  ],
  [
    "launch_name_exhausted",
    "super-agent",
    "Which unused branch and worktree names should this assignment use?",
  ],
  ["worktree_missing", "super-agent", "How should the recorded missing worktree be recovered?"],
  [
    "worktree_setup_failed",
    "super-agent",
    "How should the recorded worktree preparation failure be corrected before retrying?",
  ],
  [
    "state_busy",
    "super-agent",
    "When has the active state operation finished so this command can be retried?",
  ],
  [
    "state_incompatible",
    "person",
    "Which compatible Operator release should be used for this device state?",
  ],
  [
    "state_migration_blocked",
    "super-agent",
    "How should the recorded live operations finish before the upgrade is retried?",
  ],
] as const)(
  "%s keeps its recovery decision with the right authority",
  (reason, decider, question) => {
    expect(workflowRefusal("cleanup", reason, {})).toEqual({ next: { decider, question } });
  },
);

test.each([
  [
    "dispatch",
    "herdr_plugin_missing",
    {
      command: "operator herdr install",
      why: "Install the current release's Herdr plugin before dispatching.",
    },
  ],
  [
    "dispatch",
    "running_cap_reached",
    {
      command: "operator next --wait",
      why: "Wait for a running assignment to finish before dispatching more work.",
    },
  ],
  [
    "source_reset",
    "person_instruction_required",
    { decider: "person", question: "May this command run on your explicit instruction?" },
  ],
  [
    "source_take_over",
    "person_instruction_required",
    { decider: "person", question: "May this command run on your explicit instruction?" },
  ],
  [
    "report_submit",
    "report_returned",
    {
      command: "operator report resume",
      why: "Read the returned report's follow-up before submitting again.",
    },
  ],
  [
    "report_accept",
    "self_decision_refused",
    { decider: "super-agent", question: "What is your decision from your own supervising pane?" },
  ],
  [
    "question_ask",
    "question_key_taken",
    { decider: "super-agent", question: "Which new key should identify this question?" },
  ],
  [
    "message_send",
    "self_steering_refused",
    {
      decider: "super-agent",
      question: "What steering should the worker receive from your own supervising pane?",
    },
  ],
  [
    "obligation_add",
    "obligation_exists",
    { decider: "super-agent", question: "Which new key should identify this obligation?" },
  ],
  [
    "obligation_close",
    "obligation_not_open",
    { why: "The obligation is already closed. Nothing remains to close." },
  ],
  [
    "cleanup",
    "cleanup_unlanded_work",
    { decider: "person", question: "May the retained unlanded work be removed?" },
  ],
  [
    "internal_review_skip",
    "internal_review_ended",
    { why: "The internal review has already ended. No skip remains." },
  ],
] as const)("%s refusal %s names its recovery", (operation, reason, next) => {
  expect(workflowRefusal(operation, reason, {})).toEqual({ next });
});

test("recovery preserves exactly the checked facts, without inferring state from a reason", () => {
  const context = { state: { personInstructed: false } };
  expect(workflowRefusal("cleanup", "person_instruction_required", context)).toEqual({
    next: { decider: "person", question: "May this command run on your explicit instruction?" },
    state: { personInstructed: false },
  });
  expect(context).toEqual({ state: { personInstructed: false } });
  expect(workflowRefusal("cleanup", "state_corrupt", {})).toEqual({
    next: {
      decider: "person",
      question: "How should the damaged device state be recovered without overwriting it?",
    },
  });
});

test("an owning guard's precise recovery wins over the presentation policy", () => {
  const context = {
    next: { command: "operator report resume", why: "Read the follow-up." },
    state: { found: "returned" },
  };
  expect(workflowRefusal("report_submit", "report_returned", context)).toBe(context);
});

test("an unclassified external failure asks the supervisor, never repeats an outward effect", () => {
  expect(workflowRefusal("dispatch", "host_session_failed", {})).toEqual({
    next: {
      decider: "super-agent",
      question: "How should host_session_failed be corrected before retrying dispatch?",
    },
  });
  expect(workflowRefusal("message_read", "toString", {})).toEqual({
    next: {
      decider: "super-agent",
      question: "How should toString be corrected before retrying message_read?",
    },
  });
});

test("the workflow migration leaves other commands unchanged", () => {
  const context = {};
  expect(workflowRefusal("pr_associate", "pr_not_open", context)).toBe(context);
});
