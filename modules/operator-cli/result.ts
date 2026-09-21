export type Outcome =
  | "completed"
  | "failed"
  | "invalid"
  | "missing-condition"
  | "conflict"
  | "uncertain"
  | "pending";

export type Reason =
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
  | "attempt_reported"
  | "inspection_required"
  | "inspection_stale"
  | "writer_live"
  | "writer_unknown"
  | "question_raised"
  | "question_revised"
  | "question_open"
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
  | "answer_stale"
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
  | "approval_missing";

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
  | "attempt_dispatch"
  | "attempt_acknowledge"
  | "attempt_reconcile"
  | "attempt_replace"
  | "attempt_show"
  | "question_raise"
  | "question_revise"
  | "question_answer"
  | "question_reapply"
  | "question_deliver"
  | "question_acknowledge"
  | "question_show"
  | "approval_grant"
  | "approval_revoke"
  | "approval_check";

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
