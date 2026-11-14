// Stryker disable all: no logic
/** The next command, a choice for a named authority, or an explanation that no action remains. */
export type NextStep =
  | { command: string; why: string; decider?: never; question?: never }
  | { decider: "person" | "super-agent"; question: string; command?: never; why?: never }
  | { why: string; command?: never; decider?: never; question?: never };

/** Optional during the refusal migration. State contains only facts checked by the operation. */
export type ResultContext = { next?: NextStep; state?: Record<string, unknown> };
