import { z } from "zod";

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export type Diagnostic = { name: string; message: string };
export function diagnostic(cause: unknown): Diagnostic {
  return cause instanceof Error
    ? { name: cause.name, message: cause.message }
    : { name: "ThrownValue", message: String(cause) };
}

// Application knowledge, not the Result representation, determines external uncertainty.
export type OperationError =
  | { type: "transport"; evidence: "unknown"; cause: Diagnostic }
  | { type: "tool"; evidence: "unknown"; exitCode: number; stderr: string }
  | { type: "invalid-response"; evidence: "unknown"; detail: string }
  | { type: "rejected"; evidence: "not-applied"; detail: string }
  | { type: "timeout"; evidence: "unknown"; milliseconds: number }
  | { type: "cancelled"; evidence: "unknown" };

export type Wire = { exitCode: number; stdout: string; stderr: string };
export type Receipt = { evidence: "applied"; reference: string };
export type ExecuteInput = {
  invoke(signal: AbortSignal): Promise<Wire>;
  signal: AbortSignal;
  project(receipt: Receipt): Receipt;
};
export type Execute = (input: ExecuteInput) => Promise<Result<Receipt, OperationError>>;
export const designs = [
  "plain",
  "neverthrow-promise",
  "neverthrow-async",
  "effect-value",
  "effect-runtime",
  "unthrown",
] as const;
export type Design = (typeof designs)[number];

const responseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("applied"), reference: z.string().min(1) }),
  z.object({ status: z.literal("rejected"), detail: z.string().min(1), terminal: z.literal(true) }),
]);

export function decode(wire: Wire): Result<Receipt, OperationError> {
  if (wire.exitCode !== 0)
    return err({ type: "tool", evidence: "unknown", exitCode: wire.exitCode, stderr: wire.stderr });
  let raw: unknown;
  try {
    raw = JSON.parse(wire.stdout);
  } catch (cause) {
    return err({
      type: "invalid-response",
      evidence: "unknown",
      detail: diagnostic(cause).message,
    });
  }
  const response = responseSchema.safeParse(raw);
  if (!response.success)
    return err({ type: "invalid-response", evidence: "unknown", detail: response.error.message });
  return response.data.status === "rejected"
    ? err({ type: "rejected", evidence: "not-applied", detail: response.data.detail })
    : ok({ evidence: "applied", reference: response.data.reference });
}

export function transportError(cause: unknown, signal: AbortSignal): OperationError {
  if (signal.aborted) return { type: "cancelled", evidence: "unknown" };
  return { type: "transport", evidence: "unknown", cause: diagnostic(cause) };
}
