// Structural, so a union of command results with different value types still fits.
type Outcome =
  | { tag: "Ok"; value: { reason: string; data: unknown } }
  | { tag: "Err"; error: { reason: string; detail: string } }
  | { tag: "Defect"; cause: unknown };

/** Device state, project, and settings refusals exit the same way from every command. */
const sharedExitCodes: Record<string, number> = {
  state_missing: 3,
  state_busy: 1,
  state_io_failed: 1,
  state_corrupt: 3,
  state_incompatible: 3,
  state_backup_failed: 1,
  state_migration_blocked: 3,
  controller_mismatch: 4,
  controller_identity_mismatch: 4,
  project_not_registered: 3,
  project_io_failed: 1,
  settings_io_failed: 1,
};

/** A shared reason wins over a command table, and an unlisted reason exits the fallback. */
export function exitCodeOf(reason: string, codes: Record<string, number> = {}, fallback = 3) {
  return sharedExitCodes[reason] ?? codes[reason] ?? fallback;
}

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

/** Prints one command result. A defect always exits 1 with the command's defect reason. */
export function respond(input: {
  operation: string;
  result: Outcome;
  exitCodes: Record<string, number>;
  fallback?: number;
  defect: string;
  json: boolean;
}) {
  const { operation, result, json } = input;
  if (result.tag === "Ok") {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          operation,
          outcome: "completed",
          reason: result.value.reason,
          blockers: [],
          data: result.value.data,
        },
        null,
        json ? undefined : 2,
      ),
    );
    process.exitCode = 0;
  } else if (result.tag === "Err") {
    const { reason, detail } = result.error;
    failure(operation, reason, detail, exitCodeOf(reason, input.exitCodes, input.fallback), json);
  } else failure(operation, input.defect, String(result.cause), 1, json);
}
