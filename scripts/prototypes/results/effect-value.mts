import * as Result from "effect/Result";
import {
  decode,
  transportError,
  type ExecuteInput,
  type OperationError,
  type Receipt,
  type Wire,
} from "./model.mts";
import type { Result as PlainResult } from "./model.mts";

export function parse(wire: Wire): Result.Result<Receipt, OperationError> {
  const parsed = decode(wire);
  return parsed.ok ? Result.succeed(parsed.value) : Result.fail(parsed.error);
}

export async function operation(
  input: ExecuteInput,
): Promise<Result.Result<Receipt, OperationError>> {
  let wire: Wire;
  try {
    wire = await input.invoke(input.signal);
  } catch (cause) {
    return Result.fail(transportError(cause, input.signal));
  }
  return Result.map(parse(wire), input.project);
}

export async function execute(input: ExecuteInput): Promise<PlainResult<Receipt, OperationError>> {
  return Result.match(await operation(input), {
    onSuccess: (value) => ({ ok: true, value }),
    onFailure: (error) => ({ ok: false, error }),
  });
}
