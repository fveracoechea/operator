import type { TrackerUpdate } from "../tracker-update/main.ts";
import { ReleaseInstall } from "../release-install/main.ts";

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
  | "matt_plan_ready"
  | "matt_skills_installed"
  | "upstream_unavailable"
  | "update_plan_ready"
  | "update_applied"
  | "update_blocked"
  | "assignments_active"
  | "unmigratable_state"
  | "code_submission_waiting"
  | "package_version_required"
  | "release_commit_mismatch"
  | "package_version_mismatch"
  | "backup_unverified"
  | "migration_failed"
  | "invalid_selection"
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
  | "invalid_config_change"
  | "config_plan_ready"
  | "config_applied"
  | "config_unchanged"
  | "config_recovery_required"
  | "config_write_failed"
  | "config_write_locked"
  | "config_recovered"
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
  | "healthcheck_passed"
  | "healthcheck_unverified"
  | "healthcheck_blocked"
  | "healthcheck_connection_failed"
  | "tool_unavailable"
  | "lock_data_missing"
  | "release_mismatch"
  | "release_unselected"
  | "unreadable_selection"
  | "install_missing"
  | "not_configured"
  | "settings_incomplete"
  | "skills_missing"
  | "instructions_missing"
  | "host_unnamed"
  | "reasoning_effort_unsupported"
  | "host_unavailable"
  | "live_check_missing"
  | "live_check_failed"
  | "live_check_skipped"
  | "evidence_stale"
  | "unreadable_evidence"
  | "probe_plan_ready"
  | "probe_blocked"
  | "probe_completed"
  | "probe_incomplete"
  | "probe_incomplete_run"
  | "probe_cleanup_blocked"
  | "probe_nothing_stale"
  | "probe_fixture_unresolved"
  | "probe_run_failed"
  | "probe_resources_removed"
  | "probe_no_resources"
  | "state_missing"
  | "unreadable_state"
  | "state_version_unsupported"
  | "state_version_outdated"
  | "request_input_changed"
  | "crew_unowned"
  | "ownership_stale"
  | "ownership_acquired"
  | "ownership_held"
  | "work_registered"
  | "registration_planned"
  | "registration_refused"
  | "plan_revision_changed"
  | "source_not_found"
  | "tracker_read_incomplete"
  | "source_without_items"
  | "source_already_registered"
  | "source_recorded_without_parent"
  | "input_issue_missing"
  | "input_issue_outside_source"
  | "issue_already_registered"
  | "wayfinder_type_unreadable"
  | "item_kind_contradicted"
  | "executable_item_in_other_repository"
  | "write_paths_required"
  | "blocker_unregistered"
  | "blocker_in_other_source"
  | "overlaps_reported"
  | "write_paths_reported"
  | "invalid_write_paths_input"
  | "not_production_work"
  | "planning_record_reported"
  | "unknown_source"
  | "invalid_work_input"
  | "source_revision_changed"
  | "dependency_cycle"
  | "fixed_input_mismatch"
  | "assignment_claimed"
  | "assignment_already_claimed"
  | "assignment_already_accepted"
  | "assignment_not_dispatchable"
  | "assignment_not_claimed"
  | "attempt_mismatch"
  | "attempt_required"
  | "attempt_not_expected"
  | "unknown_assignment"
  | "source_unreadable"
  | "source_not_text"
  | "quote_not_in_source"
  | "invalid_planning_record"
  | "planning_record_required"
  | "planning_record_not_expected"
  | "operator_decision_not_allowed"
  | "planning_body_not_allowed"
  | "planning_record_missing"
  | "resolution_body_required"
  | "comment_too_long"
  | "stale_revision"
  | "ownership_revision_stale"
  | "planning_only"
  | "assignment_accepted"
  | "next_actions_reported"
  | "next_actions_waiting"
  | "next_actions_none"
  | "wake_armed"
  | "wake_checked"
  | "wake_plugin_path"
  | "wake_failed"
  | "next_actions_blocked"
  | "frontier_ready"
  | "frontier_blocked"
  | "frontier_empty"
  | "dependency_pending"
  | "write_paths_overlap"
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
  | "herdr_workspace_required"
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
  | "result_not_one_commit"
  | "uncommitted_work"
  | "outside_write_paths"
  | "result_check_not_run"
  | "behavior_change_basis_missing"
  | "project_gate_not_passed"
  | "project_gate_missing"
  | "project_gate_invalid"
  | "project_gate_unread"
  | "gate_pending"
  | "gate_running"
  | "gate_failed"
  | "gate_flaky"
  | "gate_passed"
  | "gate_commit_unread"
  | "gate_run_started"
  | "gate_runner_not_typed"
  | "gate_runner_unknown"
  | "gate_branch_exists"
  | "gate_checkout_failed"
  | "gate_checkout_unplanned"
  | "fresh_series_not_needed"
  | "fresh_series_not_approved"
  | "gate_run_reported"
  | "unknown_gate_run"
  | "gate_run_not_running"
  | "gate_run_begun"
  | "gate_run_finished"
  | "gate_run_stopped"
  | "attempt_not_acknowledged"
  | "review_result_not_submitted"
  | "requirements_changed"
  | "artifact_unreadable"
  | "artifact_identity_changed"
  | "review_base_changed"
  | "correction_base_changed"
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
  | "outside_changes_undisposed"
  | "outside_changes_disposed"
  | "invalid_outside_disposition_input"
  | "unknown_submission"
  | "unknown_outside_change"
  | "outside_change_not_removed"
  | "outside_change_approval_missing"
  | "submission_settled"
  | "rework_pending"
  | "checks_unproven"
  | "checks_contradicted"
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
  | "install_matt_plan"
  | "install_matt_apply"
  | "update_plan"
  | "update_apply"
  | "setup_plan"
  | "setup_apply"
  | "setup_rollback"
  | "config_show"
  | "config_plan"
  | "config_apply"
  | "config_recover"
  | "setup_readiness"
  | "healthcheck"
  | "setup_probe_plan"
  | "setup_probe_apply"
  | "setup_probe_cleanup"
  | "crew_own"
  | "gate_run"
  | "gate_runner"
  | "gate_show"
  | "work_register"
  | "work_register_plan"
  | "work_claim"
  | "work_accept"
  | "work_dispose"
  | "work_frontier"
  | "work_overlaps"
  | "work_write_paths"
  | "work_record"
  | "crew_next"
  | "wake_arm"
  | "wake_check"
  | "wake_plugin_path"
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

let projectInvocation = "operator";

/** Use the project's selected command when presenting generated follow-up commands. */
export function useProjectInvocation(
  delivery: "github-source" | "jsr" | null,
  commit?: string | null,
): void {
  projectInvocation = ReleaseInstall.invocation({ delivery, commit });
}

function commandText(text: string): string {
  return projectInvocation === "operator"
    ? text
    : text.replace(
        /\boperator (?=(?:install|setup|config|update|crew|work|attempt|question|approval|review|tracker|cleanup|wake)\b)/g,
        (match, offset: number) =>
          text.slice(Math.max(0, offset - 8), offset).endsWith("bun run ")
            ? match
            : `${projectInvocation} ${match.slice("operator ".length)}`,
      );
}

export function writeJsonResult(result: JsonResult): void {
  console.log(
    JSON.stringify({ schemaVersion: 1, ...result }, (key: string, value: unknown) =>
      (key === "command" || key === "nextAction" || key === "reproof") && typeof value === "string"
        ? commandText(value)
        : value,
    ),
  );
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
      console.log(commandText(line));
    }
  }

  process.exitCode = exitCodeByOutcome[request.result.outcome];
}
