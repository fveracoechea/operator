import { ResultAsync, err, ok, type Result } from "neverthrow";
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

export function operation(input: ExecuteInput): ResultAsync<Receipt, OperationError> {
  // fromPromise(input.invoke()) would miss a synchronous throw before a Promise exists.
  return ResultAsync.fromThrowable(
    () => input.invoke(input.signal),
    (cause) => transportError(cause, input.signal),
  )()
    .andThen(parse)
    .map(input.project);
}

export async function execute(input: ExecuteInput): Promise<PlainResult<Receipt, OperationError>> {
  return operation(input).match(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
}
