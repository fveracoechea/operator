import { Result as Neverthrow, err as neverthrowErr, ok as neverthrowOk } from "neverthrow";
import * as EffectResult from "effect/Result";
import type { OperationError, Result } from "./model.mts";

function closed(error: OperationError): "unknown" | "not-applied" {
  return error.evidence;
}
function plain(result: Result<number, OperationError>): number | OperationError {
  if (result.ok) return result.value;
  // @ts-expect-error A failed Result has no successful value.
  const invalid: number = result.value;
  void invalid;
  return result.error;
}
function neverthrow(result: Neverthrow<number, OperationError>): number | OperationError {
  if (result.isOk()) return result.value;
  // @ts-expect-error Narrowing must reject the success field on Err.
  const invalid: number = result.value;
  void invalid;
  return result.error;
}
function effect(result: EffectResult.Result<number, OperationError>): number | OperationError {
  if (EffectResult.isSuccess(result)) return result.success;
  // @ts-expect-error Narrowing must reject the success field on Failure.
  const invalid: number = result.success;
  void invalid;
  return result.failure;
}
// @ts-expect-error Generic Error does not replace a closed operational error.
closed(new Error("not a closed operation error"));
// @ts-expect-error Unknown error tags must fail the contract.
closed({ type: "retry-everything", evidence: "not-applied" });
const composed = neverthrowOk(42).andThen((value) =>
  value > 0
    ? neverthrowOk(value)
    : neverthrowErr({ type: "cancelled", evidence: "unknown" } satisfies OperationError),
);
const inferred: Neverthrow<number, OperationError> = composed;
void [plain, neverthrow, effect, inferred];
