export const settingsExitCodes = {
  host_defect: 1,
  host_unavailable: 3,
  host_metadata_failed: 1,
  unsupported_model: 3,
  unsupported_effort: 3,
  profile_missing: 3,
  selection_incomplete: 3,
  invalid_settings: 2,
  invalid_settings_edit: 2,
  settings_io_failed: 1,
  settings_recovery_required: 3,
  settings_plan_required: 3,
  settings_plan_stale: 4,
  settings_external: 3,
  settings_write_unconfirmed: 5,
};

export function failure(
  operation: string,
  reason: string,
  detail: string,
  code: number,
  json: boolean,
) {
  if (json)
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        operation,
        outcome: code === 2 ? "invalid" : "refused",
        reason,
        blockers: [{ reason, detail }],
      }),
    );
  console.error(`operator: ${detail}`);
  process.exitCode = code;
}
