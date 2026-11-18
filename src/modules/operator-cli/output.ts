import type { NextStep, Refusal, ResultContext } from "../../lib/cli-result.ts";
import { workflowRefusal } from "./workflow-refusal.ts";
// Bun has no native invocation-local context API.
import { AsyncLocalStorage } from "node:async_hooks";

type ContextReader = () => Partial<ResultContext> & { failure?: Exclude<Outcome, { tag: "Ok" }> };
const workerContext = new AsyncLocalStorage<ContextReader>();

export function outputContext() {
  return workerContext.getStore()?.() ?? {};
}

/** Output context is local to one invocation, including concurrent embedded CLI callers. */
export function withOutputContext(read: ContextReader, run: () => Promise<void>) {
  return workerContext.run(read, run);
}

// Structural, so a union of command results with different value types still fits.
type Outcome =
  | { tag: "Ok"; value: { reason: string; data: unknown } & Partial<ResultContext> }
  | { tag: "Err"; error: Refusal }
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
  context: ResultContext,
) {
  const defaults = outputContext();
  if (defaults.failure !== undefined) return contextFailure(operation, defaults.failure, json);
  context = { ...defaults, ...context, next: context.next ?? defaults.next };
  if (json)
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        operation,
        outcome: code === 2 ? "invalid" : "refused",
        reason,
        blockers: [{ reason, detail }],
        next: context.next,
        state: context.state,
        kind: context.kind,
        phase: context.phase,
      }),
    );
  printResolvedRefusal(reason, detail, context, context);
  process.exitCode = code;
}

/** The compact text form, also used by readiness's existing multi-blocker envelope. */
export function printRefusal(
  reason: string,
  detail: string,
  context: ResultContext | ResultContext[],
) {
  const grouped = Array.isArray(context);
  const worker = grouped ? outputContext() : { ...outputContext(), ...context };
  printResolvedRefusal(reason, detail, context, worker);
}

/** Render the checked snapshot without another state read between JSON and text. */
function printResolvedRefusal(
  reason: string,
  detail: string,
  context: ResultContext | ResultContext[],
  worker: Partial<ResultContext>,
) {
  const grouped = Array.isArray(context);
  const contexts = grouped ? context : [context];
  const phase = worker.kind === undefined ? "" : ` [kind=${worker.kind} phase=${worker.phase}]`;
  console.error(oneLine(`operator: ${reason}: ${detail}${phase}`));
  console.error(
    oneLine(
      `next: ${contexts
        .map((item, index) => `${grouped ? `[${index + 1}] ` : ""}${nextText(item.next)}`)
        .join("; ")}`,
    ),
  );
  if (contexts.some((item) => item.state !== undefined))
    console.error(
      oneLine(
        `state: ${contexts
          .flatMap((item, index) => {
            if (item.state === undefined) return [];
            if (grouped) return [`[${index + 1}]=${JSON.stringify(item.state)}`];
            return Object.entries(item.state).map(
              ([key, value]) => `${key}=${JSON.stringify(value)}`,
            );
          })
          .join(" ")}`,
      ),
    );
}

function oneLine(text: string) {
  return text.replaceAll(/[\r\n\u2028\u2029]+/g, " ");
}

function nextText(next: NextStep) {
  if (next.command !== undefined) return next.command;
  if (next.decider !== undefined) return `${next.decider} decides: ${next.question}`;
  return next.why;
}

/** Help and version keep their plain text while sharing the worker result contract. */
export function printWorkerContext() {
  const context = outputContext();
  if (context.failure !== undefined) {
    contextFailure("worker_context", context.failure, false);
    return false;
  }
  if (context.kind === undefined) return true;
  console.log(oneLine(`kind: ${context.kind}; phase: ${context.phase}`));
  if (context.next !== undefined) console.log(oneLine(`next: ${nextText(context.next)}`));
  return true;
}

export function contextFailure(
  operation: string,
  result: Exclude<Outcome, { tag: "Ok" }>,
  json: boolean,
): void {
  return workerContext.run(
    () => ({}),
    () => respond({ operation, result, exitCodes: {}, defect: "worker_phase_defect", json }),
  );
}

/** Prints one command result. A defect always exits 1 with the command's defect reason. */
export function respond(input: {
  operation: string;
  result: Outcome;
  exitCodes: Record<string, number>;
  fallback?: number;
  defect: string;
  json: boolean;
}): void {
  const { operation, result, json } = input;
  if (result.tag === "Ok") {
    const defaults = outputContext();
    if (defaults.failure !== undefined) return contextFailure(operation, defaults.failure, json);
    const context = { ...defaults, ...result.value, next: result.value.next ?? defaults.next };
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          operation,
          outcome: "completed",
          reason: result.value.reason,
          blockers: [],
          data: result.value.data,
          next: context.next,
          state: context.state,
          kind: context.kind,
          phase: context.phase,
        },
        null,
        json ? undefined : 2,
      ),
    );
    process.exitCode = 0;
  } else if (result.tag === "Err") {
    const { reason, detail } = result.error;
    failure(
      operation,
      reason,
      detail,
      exitCodeOf(reason, input.exitCodes, input.fallback),
      json,
      result.error,
    );
  } else
    failure(
      operation,
      input.defect,
      String(result.cause),
      1,
      json,
      workflowRefusal(operation, input.defect, {}),
    );
}
