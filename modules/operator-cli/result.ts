import type { CrewState } from "../crew-state/main.ts";
import type { TrackerUpdate } from "../tracker-update/main.ts";
import type { ParsedArguments } from "./arguments.ts";
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

/** The refusals of a publish plan, read from the crew-state result rather than copied. */
type PublishRefusalReason = Extract<
  Awaited<ReturnType<typeof CrewState.planPublish>>["result"],
  { status: "planned" }
>["refusals"][number]["reason"];

/** The refusals of a rebase plan, read from the crew-state result rather than copied. */
type RebaseRefusalReason = Extract<
  Awaited<ReturnType<typeof CrewState.planRebase>>["result"],
  { status: "planned" }
>["refusals"][number]["reason"];

export type Reason =
  | TrackerReason
  | PublishRefusalReason
  | RebaseRefusalReason
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
  | "source_kind_changed"
  | "recorded_item_changed"
  | "recorded_item_closed"
  | "withdrawn_item_readded"
  | "withdrawal_attempt_active"
  | "withdrawal_effect_unsettled"
  | "withdrawal_dependent_pending"
  | "blocker_withdrawn"
  | "input_issue_missing"
  | "input_issue_outside_source"
  | "issue_already_registered"
  | "wayfinder_type_unreadable"
  | "item_kind_contradicted"
  | "executable_item_in_other_repository"
  | "write_paths_required"
  | "blocker_unregistered"
  | "blocker_in_other_source"
  | "blocker_completed_after_base"
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
  | "assignment_withdrawn"
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
  | "attempt_reference_malformed"
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
  | "integration_branch_moved"
  | "integration_branch_exists"
  | "integration_branch_held"
  | "integration_branch_unread"
  | "integration_branch_checked_out"
  | "integration_branch_missing"
  | "landing_conflict"
  | "landing_patch_changed"
  | "landing_pending"
  | "rewrite_pending"
  | "rewrite_published_range"
  | "rewrite_tracker_recorded"
  | "take_out_pending"
  | "take_out_plan_changed"
  | "nothing_to_take_out"
  | "commits_taken_out"
  | "rebase_planned"
  | "rebased"
  | "rebase_pending"
  | "rebase_stopped"
  | "landing_tip_changed"
  | "lands_cleanly"
  | "no_landing"
  | "dispatch_base_not_tip"
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
  | "snapshot_drift"
  | "review_finding_untargeted"
  | "review_finding_target_unknown"
  | "correction_target_required"
  | "correction_target_unknown"
  | "correction_target_not_expected"
  | "review_axes_incomplete"
  | "review_axes_not_parallel"
  | "review_host_mismatch"
  | "review_sub_agent_host_mismatch"
  | "review_sub_agent_failed"
  | "review_coverage_incomplete"
  | "review_published_text_missing"
  | "review_cut_not_between_commits"
  | "pull_request_retargeted"
  | "recall_planned"
  | "stack_recalled"
  | "nothing_to_recall"
  | "invalidation_merged"
  | "retarget_not_due"
  | "publish_planned"
  | "publish_refused"
  | "published"
  | "publish_conflict"
  | "publish_failed"
  | "publish_uncertain"
  | "publish_observed"
  | "publish_unread"
  | "publish_unsettled"
  | "nothing_published"
  | "stack_fault"
  | "merge_not_observed"
  | "code_resolution_body_not_allowed"
  | "completion_reason_not_approved"
  | "publish_approval_missing"
  | "map_amendment_approval_required"
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
  | "unlanded_work"
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
  | "head_moved"
  | "landing_not_held"
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
  | "publish_plan"
  | "publish_apply"
  | "publish_status"
  | "publish_retarget"
  | "publish_recall"
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
  | "work_take_out"
  | "work_rebase"
  | "work_rebase_plan"
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
// The operation words that a project invocation rewrites. It matches nothing until one is chosen.
let operatorCommandPattern = /(?!)/g;

/** Use the project's selected command when presenting generated follow-up commands. */
export function useProjectInvocation(
  delivery: "github-source" | "jsr" | null,
  commit: string | null,
  commandWords: readonly string[],
): void {
  projectInvocation = ReleaseInstall.invocation({ delivery, commit });
  operatorCommandPattern = new RegExp(`\\boperator (?=(?:${commandWords.join("|")})\\b)`, "g");
}

function commandText(text: string): string {
  return projectInvocation === "operator"
    ? text
    : text.replace(operatorCommandPattern, (match, offset: number) =>
        text.slice(Math.max(0, offset - 8), offset).endsWith("bun run ")
          ? match
          : `${projectInvocation} ${match.slice("operator ".length)}`,
      );
}

export function writeJsonResult(result: JsonResult): void {
  console.log(
    JSON.stringify({ schemaVersion: 1, ...result }, (key: string, value: unknown) => {
      // A probe plan names the fixture command among its credentials.
      if ((key === "nextActions" || key === "credentials") && Array.isArray(value)) {
        return value.map((one: unknown) => (typeof one === "string" ? commandText(one) : one));
      }
      return (key === "command" || key === "nextAction" || key === "reproof") &&
        typeof value === "string"
        ? commandText(value)
        : value;
    }),
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

/**
 * One answer to a crew-state status that is not the success of the command. A refusal carries
 * one blocker under its own reason, built from `detail`, unless it names its `blockers`. A
 * completed answer, such as a repeated acknowledgement, names no blocker.
 */
export type Refusal = {
  outcome: Outcome;
  reason: Reason;
  lines: string[];
  detail?: Record<string, unknown>;
  blockers?: JsonResult["blockers"];
  data?: unknown;
};

/** The answers of one command, each one typed against its own member of the result union. */
export type Refusals<Result extends { status: string }> = {
  [S in Result["status"]]?: (result: Extract<Result, { status: S }>) => Refusal;
};

/**
 * One blocker that counts the items under its reason, or none for no items. A command the
 * Operator reads gives the count and keeps the list in `data` (R5).
 */
export function countedBlockers(reason: Reason, items: readonly unknown[]): JsonResult["blockers"] {
  return items.length === 0 ? [] : [{ reason, count: items.length }];
}

type SharedFailure = {
  reason: Reason;
  outcome: "failed" | "invalid" | "missing-condition" | "conflict";
  line: string;
};

/**
 * The outcomes every crew-state call shares: a state file that cannot serve a request, a reused
 * request identity carrying different input, and a missing or replaced ownership token.
 */
const sharedFailures = {
  "state-missing": {
    reason: "state_missing",
    outcome: "missing-condition",
    line: "This project holds no crew state. Run `operator crew own` to start a crew.",
  },
  "state-unreadable": {
    reason: "unreadable_state",
    outcome: "conflict",
    line: "The crew state cannot be read. Nothing was dispatched and nothing was replaced.",
  },
  "state-outdated": {
    reason: "state_version_outdated",
    outcome: "missing-condition",
    line: "The crew state was written by an earlier Operator release. Run `operator update` to migrate it.",
  },
  "state-unsupported": {
    reason: "state_version_unsupported",
    outcome: "failed",
    line: "The crew state was written by a newer Operator release. Update Operator to read it.",
  },
  "request-input-changed": {
    reason: "request_input_changed",
    outcome: "invalid",
    line: "This request identity already recorded different input. Use a new request identity.",
  },
  unowned: {
    reason: "crew_unowned",
    outcome: "missing-condition",
    line: "No Operator owns this crew. Run `operator crew own` first.",
  },
  "ownership-stale": {
    reason: "ownership_stale",
    outcome: "conflict",
    line: "Another Operator took ownership of this crew. This token can no longer change state.",
  },
  "unknown-attempt": {
    reason: "unknown_attempt",
    outcome: "invalid",
    line: "No attempt is recorded under that identity.",
  },
  "attempt-ended": {
    reason: "attempt_ended",
    outcome: "conflict",
    line: "That attempt has ended, so it can no longer write. Claim the assignment again.",
  },
  "attempt-not-current": {
    reason: "attempt_not_current",
    outcome: "conflict",
    line: "Another Operator owns this crew, so this attempt is not the current writer.",
  },
  "not-dispatched": {
    reason: "attempt_not_dispatched",
    outcome: "missing-condition",
    line: "That attempt has no recorded launch. Dispatch it first.",
  },
  "not-acknowledged": {
    reason: "attempt_not_acknowledged",
    outcome: "missing-condition",
    line: "That attempt never acknowledged its brief, so it has nothing fixed to hand over.",
  },
  "unknown-approval": {
    reason: "unknown_approval",
    outcome: "missing-condition",
    line: "No approval is recorded under that identity.",
  },
  "approval-revoked": {
    reason: "approval_revoked",
    outcome: "missing-condition",
    line: "That approval was revoked, so it authorizes nothing.",
  },
  "approval-mismatch": {
    reason: "approval_mismatch",
    outcome: "missing-condition",
    line: "That approval was granted for a different action, target, scope, or request revision.",
  },
  "unknown-review": {
    reason: "unknown_review",
    outcome: "invalid",
    line: "No review is recorded under that identity.",
  },
  "invalid-configuration": {
    reason: "invalid_configuration",
    outcome: "invalid",
    line: "The Operator configuration is not valid, so the crew size is unknown.",
  },
} satisfies Record<string, SharedFailure>;

/** The statuses that every crew-state call shares. `answer` reports them for every command. */
export type SharedStatus = keyof typeof sharedFailures;

const sharedByStatus: Record<string, SharedFailure | undefined> = sharedFailures;

/** The shared answer to a status, or the answer of the command's own table. */
function refusalOf(
  result: { status: string },
  refusals: Record<string, ((result: never) => Refusal) | undefined>,
): Refusal | null {
  const { status, ...detail } = result;
  const shared = sharedByStatus[status];
  if (shared !== undefined) {
    return { outcome: shared.outcome, reason: shared.reason, lines: [shared.line], detail };
  }

  const entry = refusals[status];
  // The table types each entry against the member of the union that carries its status, and the
  // status was just read from this result, so the result is that member.
  return entry === undefined ? null : entry(result as never);
}

/**
 * Answers every status of a crew-state result that is not the success of the command: the
 * shared failures, then the command's own table. Returns true when it reported, so the caller
 * handles only the statuses the table does not hold.
 */
export function answer<Result extends { status: string }, Table extends Refusals<Result>>(
  parsed: ParsedArguments,
  operation: Operation,
  result: Result,
  refusals: Table,
): result is Extract<Result, { status: SharedStatus | keyof Table }> {
  const refusal = refusalOf(result, refusals);
  if (refusal === null) {
    return false;
  }

  reportRefusal(parsed, operation, refusal);
  return true;
}

/** The result and the readable lines of one answer to one operation. */
export function refusalReport(
  operation: Operation,
  refusal: Refusal,
): { result: JsonResult; lines: string[] } {
  const { outcome, reason } = refusal;
  return {
    result: {
      outcome,
      reason,
      blockers:
        refusal.blockers ?? (outcome === "completed" ? [] : [{ reason, ...refusal.detail }]),
      operation,
      data: refusal.data,
    },
    lines: refusal.lines,
  };
}

/** Reports one answer to one operation. */
export function reportRefusal(
  parsed: ParsedArguments,
  operation: Operation,
  refusal: Refusal,
): Handled {
  report({ json: parsed.json, ...refusalReport(operation, refusal) });
  return "reported";
}

/** What one apply gives the approval gate: its ids, its plan data, and its plan lines. */
export type ApprovalGate = {
  /** The current and the approved plan ids, under the names and in the order of the JSON. */
  ids: Record<string, string | null>;
  /** The config apply refuses a stale approval as a conflict. Every other apply waits. */
  staleOutcome?: "conflict";
  /** The first line when no approval was given, and when the given one is stale. */
  headline?: { required: string; stale: string };
  lines: string[];
  data: unknown;
};

/**
 * The refusal of an apply that waits on the person: no approval was given, or the given one
 * no longer names the current plan. Nothing was written. Its one blocker names the current
 * and the approved ids, so the person can see which plan to approve.
 */
export function approvalGate(request: ApprovalGate & { stale: boolean }): Refusal {
  const reason = request.stale ? "approval_stale" : "approval_required";
  const { headline } = request;
  return {
    outcome: request.stale ? (request.staleOutcome ?? "missing-condition") : "missing-condition",
    reason,
    blockers: [{ reason, ...request.ids }],
    data: request.data,
    lines: [
      ...(headline === undefined ? [] : [request.stale ? headline.stale : headline.required]),
      ...request.lines,
    ],
  };
}

/** Reports the approval gate of one apply. */
export function reportApprovalGate(
  parsed: ParsedArguments,
  operation: Operation,
  gate: ApprovalGate & { stale: boolean },
): Handled {
  return reportRefusal(parsed, operation, approvalGate(gate));
}

/** The two rows of the approval gate, for the refusal table of an apply. */
export function approvalRefusals<Result extends { status: "approval-required" | "approval-stale" }>(
  gate: (result: Result) => ApprovalGate,
) {
  return {
    "approval-required": (result: Result) => approvalGate({ ...gate(result), stale: false }),
    "approval-stale": (result: Result) => approvalGate({ ...gate(result), stale: true }),
  };
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
