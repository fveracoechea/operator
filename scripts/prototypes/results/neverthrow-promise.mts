import { type Result, err, ok } from "neverthrow";
import {
  decode,
  transportError,
  type ExecuteInput,
  type OperationError,
  type Receipt,
  type Wire,
} from "./model.mts";
import type { Result as PlainResult } from "./model.mts";

function parse(wire: Wire): Result<Receipt, OperationError> {
  const parsed = decode(wire);
  return parsed.ok ? ok(parsed.value) : err(parsed.error);
}

export async function operation(input: ExecuteInput): Promise<Result<Receipt, OperationError>> {
  let wire: Wire;
  try {
    wire = await input.invoke(input.signal);
  } catch (cause) {
    return err(transportError(cause, input.signal));
  }
  return parse(wire).map(input.project);
}

export async function execute(input: ExecuteInput): Promise<PlainResult<Receipt, OperationError>> {
  return (await operation(input)).match(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
}
