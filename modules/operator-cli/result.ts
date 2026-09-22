import type { TrackerUpdate } from "../tracker-update/main.ts";

/** What one command did with its request: it reported a result, or it cannot read the request. */
export type Handled = "reported" | "invalid-arguments";

export type Outcome =
  | "completed"
  | "failed"
  | "invalid"
  | "missing-condition"
  | "conflict"
  | "uncertain"
  | "pending";

/**
 * The tracker contract fixes these identifiers, so they are read from it rather than copied.
 * They are provider-neutral; provider detail travels in the blocker beside the reason.
 */
export type TrackerReason = Awaited<ReturnType<typeof TrackerUpdate.read>>["verdict"]["reason"];

export type Reason =
  | TrackerReason
  | "invalid_arguments"
  | "unsupported_bun"
  | "version_reported"
  | "missing_target"
  | "skills_installed"
  | "skills_already_installed"
  | "skill_copy_conflict"
  | "skill_copy_modified"
  | "plan_ready"
  | "already_configured"
  | "setup_conflict"
  | "setup_applied"
  | "approval_required"
  | "approval_stale"
  | "operator_directory_tracked"
  | "invalid_configuration"
  | "instructions_modified"
  | "restored"
  | "nothing_to_restore"
  | "restore_conflict"
  | "setup_complete"
  | "setup_interrupted"
  | "unreadable_journal"
  | "git_unavailable"
  | "readiness_ready"
  | "readiness_unverified"
  | "readiness_blocked"
  | "tool_unavailable"
  | "lock_data_missing"
  | "release_mismatch"
  | "not_configured"
  | "settings_incomplete"
  | "skills_missing"
  | "instructions_missing"
  | "host_unnamed"
  | "host_unavailable"
  | "live_check_missing"
  | "live_check_failed"
  | "evidence_stale"
  | "unreadable_evidence"
  | "probe_plan_ready"
  | "probe_blocked"
  | "live_probe_unavailable"
  | "state_missing"
  | "unreadable_state"
  | "state_version_unsupported"
  | "request_input_changed"
  | "crew_unowned"
  | "ownership_stale"
  | "ownership_acquired"
  | "ownership_held"
  | "work_registered"
  | "invalid_work_input"
  | "source_revision_changed"
  | "unknown_dependency"
  | "dependency_cycle"
  | "dependencies_changed"
  | "assignment_claimed"
  | "assignment_already_claimed"
  | "assignment_already_accepted"
  | "assignment_not_dispatchable"
  | "assignment_not_claimed"
  | "attempt_mismatch"
  | "attempt_required"
  | "attempt_not_expected"
  | "unknown_assignment"
  | "stale_revision"
  | "ownership_revision_stale"
  | "planning_only"
  | "assignment_accepted"
  | "next_actions_reported"
  | "next_actions_waiting"
  | "next_actions_none"
  | "next_actions_blocked"
  | "frontier_ready"
  | "frontier_blocked"
  | "frontier_empty"
  | "dependency_pending"
  | "review_capacity_reserved"
  | "crew_at_capacity"
  | "unknown_attempt"
  | "attempt_ended"
  | "attempt_not_current"
  | "attempt_not_dispatched"
  | "attempt_reference_missing"
  | "attempt_reference_mismatch"
  | "attempt_dispatched"
  | "acknowledgement_pending"
  | "attempt_acknowledged"
  | "attempt_already_acknowledged"
  | "dispatch_stage_failed"
  | "dispatch_stage_uncertain"
  | "reconciliation_required"
  | "snapshot_drift"
  | "snapshot_unreadable"
  | "dispatch_plan_changed"
  | "commit_required"
  | "attempt_reconciled"
  | "attempt_replaced"
  | "attempt_adopted"
  | "attempt_already_adopted"
  | "adoption_writer_stopped"
  | "attempt_reported"
  | "inspection_required"
  | "inspection_stale"
  | "writer_live"
  | "writer_unknown"
  | "question_raised"
  | "question_revised"
  | "question_escalated"
  | "question_open"
  | "question_closed"
  | "invalid_question_input"
  | "unknown_question"
  | "question_mismatch"
  | "stale_question_revision"
  | "delivery_started"
  | "answer_recorded"
  | "invalid_answer_input"
  | "already_answered"
  | "escalation_required"
  | "unknown_answer"
  | "answer_not_earlier"
  | "answer_missing"
  | "answer_delivered"
  | "delivery_uncertain"
  | "delivery_failed"
  | "question_acknowledged"
  | "question_already_acknowledged"
  | "question_not_delivered"
  | "question_reference_mismatch"
  | "question_reported"
  | "invalid_approval_input"
  | "unknown_approval"
  | "approval_granted"
  | "approval_revoked"
  | "approval_already_revoked"
  | "approval_mismatch"
  | "approval_matched"
  | "approval_missing"
  | "invalid_submission_input"
  | "result_submitted"
  | "result_already_submitted"
  | "attempt_not_acknowledged"
  | "review_result_not_submitted"
  | "requirements_changed"
  | "artifact_unreadable"
  | "artifact_identity_changed"
  | "review_base_changed"
  | "review_pending"
  | "invalid_review_report"
  | "unknown_review"
  | "review_submission_missing"
  | "review_not_assigned"
  | "review_settled"
  | "review_worktree_changed"
  | "submission_drift"
  | "review_axes_incomplete"
  | "review_axes_not_parallel"
  | "review_host_mismatch"
  | "review_sub_agent_host_mismatch"
  | "review_sub_agent_failed"
  | "review_coverage_incomplete"
  | "review_reported"
  | "review_blocked"
  | "invalid_disposition_input"
  | "review_not_reported"
  | "unknown_finding"
  | "blocker_not_deferrable"
  | "findings_disposed"
  | "review_shown"
  | "submission_required"
  | "submission_mismatch"
  | "review_incomplete"
  | "findings_undisposed"
  | "rework_pending"
  | "checks_unproven"
  | "checks_contradicted"
  | "pr_authority_missing"
  | "pr_head_required"
  | "pr_head_changed"
  | "review_attempt_limit"
  | "tracker_steps_reported"
  | "invalid_rework_input"
  | "rework_delegated"
  | "rework_cycle_open"
  | "assignment_not_awaiting_review"
  | "review_not_of_submission"
  | "no_corrections"
  | "conflict_not_corrected"
  | "unknown_check"
  | "checks_passed"
  | "limit_reached"
  | "direction_required"
  | "invalid_defect_input"
  | "assignment_not_accepted"
  | "result_invalidated"
  | "input_invalidated"
  | "review_not_invalidated"
  | "cleanup_reported"
  | "process_closed"
  | "process_already_closed"
  | "worktree_removed"
  | "worktree_already_removed"
  | "cleanup_blocked"
  | "cleanup_uncertain"
  | "cleanup_failed"
  | "invalid_hold_input"
  | "resources_held"
  | "resources_already_held"
  | "resources_released"
  | "retention_hold"
  | "no_retention_hold"
  | "handoff_missing"
  | "revisions_changed"
  | "unexpected_work"
  | "unexpected_files"
  | "unpushed_commits"
  | "evidence_missing"
  | "evidence_changed"
  | "unfamiliar_process"
  | "occupancy_unknown"
  | "workspace_handle_missing"
  | "identity_mismatch"
  | "checkout_in_use"
  | "unrelated_resource"
  | "checkout_unknown"
  | "host_unsupported"
  | "process_live"
  | "preservation_failed"
  | "writer_active";

export type Operation =
  | "parse_arguments"
  | "startup"
  | "version"
  | "install"
  | "setup_plan"
  | "setup_apply"
  | "setup_rollback"
  | "setup_readiness"
  | "setup_probe_plan"
  | "setup_probe_apply"
  | "crew_own"
  | "work_register"
  | "work_claim"
  | "work_accept"
  | "work_frontier"
  | "crew_next"
  | "attempt_dispatch"
  | "attempt_acknowledge"
  | "attempt_reconcile"
  | "attempt_replace"
  | "attempt_adopt"
  | "attempt_show"
  | "question_raise"
  | "question_revise"
  | "question_escalate"
  | "question_answer"
  | "question_reapply"
  | "question_deliver"
  | "question_acknowledge"
  | "question_show"
  | "approval_grant"
  | "approval_revoke"
  | "approval_check"
  | "attempt_submit"
  | "review_report"
  | "review_dispose"
  | "review_show"
  | "tracker_record"
  | "tracker_recover"
  | "tracker_show"
  | "tracker_map"
  | "work_rework"
  | "work_invalidate"
  | "cleanup_close"
  | "cleanup_remove"
  | "cleanup_hold"
  | "cleanup_release"
  | "cleanup_show";

export const exitCodeByOutcome = {
  completed: 0,
  failed: 1,
  invalid: 2,
  "missing-condition": 3,
  conflict: 4,
  uncertain: 5,
  pending: 6,
} satisfies Record<Outcome, number>;

type JsonResult = {
  outcome: Outcome;
  reason: Reason;
  blockers: Array<{ reason: Reason; [key: string]: unknown }>;
  operation: Operation;
  data?: unknown;
};

export function writeJsonResult(result: JsonResult): void {
  console.log(JSON.stringify({ schemaVersion: 1, ...result }));
}

/**
 * Reports one refusal: the outcome, the single blocker that names it, and the readable lines.
 * Every refusal carries exactly one blocker under its own reason, so that rule lives here
 * rather than being rebuilt at each call site.
 */
export function refuse(request: {
  json: boolean;
  operation: Operation;
  outcome: Exclude<Outcome, "completed">;
  reason: Reason;
  detail?: Record<string, unknown>;
  lines: string[];
}): Handled {
  report({
    json: request.json,
    result: {
      outcome: request.outcome,
      reason: request.reason,
      blockers: [{ reason: request.reason, ...request.detail }],
      operation: request.operation,
    },
    lines: request.lines,
  });
  return "reported";
}

/** Reports one command result: JSON for agents on stdout, readable lines for a person. */
export function report(request: { json: boolean; result: JsonResult; lines: string[] }): void {
  if (request.json) {
    writeJsonResult(request.result);
  } else {
    for (const line of request.lines) {
      console.log(line);
    }
  }

  process.exitCode = exitCodeByOutcome[request.result.outcome];
}
