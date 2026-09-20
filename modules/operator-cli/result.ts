export type Outcome =
  | "completed"
  | "failed"
  | "invalid"
  | "missing-condition"
  | "conflict"
  | "uncertain"
  | "pending";

type Reason =
  | "configuration_schema_conflict"
  | "install_target_required"
  | "instruction_conflict"
  | "invalid_configuration"
  | "invalid_arguments"
  | "operator_state_tracked"
  | "skill_copy_conflict"
  | "skills_already_installed"
  | "skills_installed"
  | "setup_approval_required"
  | "setup_applied"
  | "setup_configured"
  | "setup_interrupted"
  | "setup_plan_changed"
  | "setup_path_symlink"
  | "setup_recovered"
  | "setup_recovery_approval_required"
  | "setup_recovery_conflict"
  | "setup_recovery_damaged"
  | "setup_recovery_not_found"
  | "setup_recovery_plan_changed"
  | "setup_recovery_required"
  | "setup_target_required"
  | "unsupported_bun"
  | "version_reported";
type Operation = "install" | "parse_arguments" | "setup" | "startup" | "version";

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
