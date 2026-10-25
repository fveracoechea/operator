import { Err, Ok, fromPromise, type AsyncResult } from "unthrown";
import {
  decode,
  transportError,
  type ExecuteInput,
  type OperationError,
  type Receipt,
  type Result,
} from "./model.mts";

export function operation(input: ExecuteInput): AsyncResult<Receipt, OperationError> {
  return fromPromise(
    () => input.invoke(input.signal),
    (cause) => transportError(cause, input.signal),
  )
    .flatMap((wire) => {
      const parsed = decode(wire);
      return parsed.ok ? Ok(parsed.value) : Err(parsed.error);
    })
    .map(input.project);
}

export async function execute(input: ExecuteInput): Promise<Result<Receipt, OperationError>> {
  return operation(input).match({
    ok: (value) => ({ ok: true, value }) as const,
    errCases: (matcher) =>
      matcher
        .with({ type: "transport" }, (error) => ({ ok: false, error }) as const)
        .with({ type: "tool" }, (error) => ({ ok: false, error }) as const)
        .with({ type: "invalid-response" }, (error) => ({ ok: false, error }) as const)
        .with({ type: "rejected" }, (error) => ({ ok: false, error }) as const)
        .with({ type: "timeout" }, (error) => ({ ok: false, error }) as const)
        .with({ type: "cancelled" }, (error) => ({ ok: false, error }) as const),
    // Preserve the consuming CLI's existing outer exception boundary.
    defect(cause) {
      throw cause;
    },
  });
}
