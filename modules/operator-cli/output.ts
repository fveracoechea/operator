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
