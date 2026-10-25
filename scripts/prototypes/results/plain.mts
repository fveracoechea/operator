import {
  decode,
  err,
  ok,
  transportError,
  type ExecuteInput,
  type OperationError,
  type Receipt,
  type Result,
  type Wire,
} from "./model.mts";

export async function execute(input: ExecuteInput): Promise<Result<Receipt, OperationError>> {
  let wire: Wire;
  // Only the foreign call belongs in this catch. Our projection must still expose defects.
  try {
    wire = await input.invoke(input.signal);
  } catch (cause) {
    return err(transportError(cause, input.signal));
  }
  const parsed = decode(wire);
  if (!parsed.ok) return parsed;
  return ok(input.project(parsed.value));
}
