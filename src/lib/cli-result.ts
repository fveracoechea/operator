// Stryker disable all: no logic
/** The next command, a choice for a named authority, or an explanation that no action remains. */
export type NextStep =
  | { command: string; why: string; decider?: never; question?: never }
  | { decider: "person" | "super-agent"; question: string; command?: never; why?: never }
  | { why: string; command?: never; decider?: never; question?: never };

/** State contains only facts checked by the operation. Success may use Partial<ResultContext>. */
export type ResultContext = {
  next: NextStep;
  state?: Record<string, unknown>;
  kind?: string;
  phase?: string;
};

/** Every refusal supplies recovery at the owner of the checked facts. */
export type RefusalContext = ResultContext;

export type Refusal = RefusalContext & { reason: string; detail: string };
