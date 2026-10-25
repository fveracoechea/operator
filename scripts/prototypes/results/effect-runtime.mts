import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Cause from "effect/Cause";
import { parse } from "./effect-value.mts";
import {
  err,
  transportError,
  type ExecuteInput,
  type OperationError,
  type Receipt,
  type Result as PlainResult,
} from "./model.mts";

export function operation(input: ExecuteInput): Effect.Effect<Receipt, OperationError> {
  return Effect.tryPromise({
    try: (signal) => input.invoke(AbortSignal.any([signal, input.signal])),
    catch: (cause) => transportError(cause, input.signal),
  }).pipe(
    Effect.flatMap((wire) => Effect.fromResult(parse(wire))),
    Effect.flatMap((receipt) => Effect.uninterruptible(Effect.sync(() => input.project(receipt)))),
  );
}

export async function execute(input: ExecuteInput): Promise<PlainResult<Receipt, OperationError>> {
  const exit = await Effect.runPromiseExit(Effect.result(operation(input)), {
    signal: input.signal,
  });
  if (Exit.isFailure(exit)) {
    // Interruption is not a typed operation failure. Preserve the external obligation.
    if (Cause.hasInterruptsOnly(exit.cause)) return err({ type: "cancelled", evidence: "unknown" });
    throw new Error("Effect defect", { cause: exit.cause });
  }
  return Result.match(exit.value, {
    onSuccess: (value) => ({ ok: true, value }),
    onFailure: (error) => ({ ok: false, error }),
  });
}
