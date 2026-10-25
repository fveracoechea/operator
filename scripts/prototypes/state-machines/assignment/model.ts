import { z } from "zod";

const effectSchema = z.enum(["merge-pr", "delete-remote-branch", "close-pane", "remove-worktree"]);
const operationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("idle") }),
  z.object({
    status: z.enum(["pending", "failed", "unknown"]),
    effect: effectSchema,
    key: z.string(),
    attempt: z.number().int().positive(),
  }),
]);
const fields = { operation: operationSchema, generation: z.number().int().nonnegative() };
export const stateSchema = z.discriminatedUnion("completion", [
  z.object({
    ...fields,
    completion: z.literal("pr"),
    phase: z.enum(["ready", "running", "pr-open", "merged", "abandoned"]),
  }),
  z.object({
    ...fields,
    completion: z.literal("report"),
    phase: z.enum(["ready", "running", "reported", "completed", "abandoned"]),
    reports: z.array(z.string()),
    followUp: z.string().nullable(),
  }),
]);
export const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start") }),
  z.object({ type: z.literal("open-pr") }),
  z.object({ type: z.literal("submit"), report: z.string().min(1) }),
  z.object({ type: z.literal("accept") }),
  z.object({ type: z.literal("return"), instructions: z.string().min(1) }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("merge") }),
  z.object({ type: z.literal("retry") }),
  z.object({ type: z.literal("recover") }),
  z.object({
    type: z.literal("result"),
    key: z.string(),
    outcome: z.enum(["done", "not-applied", "unknown"]),
  }),
]);
export const factsSchema = z.object({
  dependenciesReady: z.boolean(),
  actor: z.enum(["worker", "superagent"]),
  worker: z.enum(["running", "stopped"]),
  approved: z.boolean(),
  checks: z.enum(["pass", "fail", "pending"]),
  threadsResolved: z.boolean(),
  defaultBase: z.boolean(),
  safeToRemove: z.boolean(),
  observation: z.enum(["done", "not-done", "unknown"]),
});
export type State = z.infer<typeof stateSchema>;
export type Event = z.infer<typeof eventSchema>;
export type Facts = z.infer<typeof factsSchema>;
export type Effect = { type: z.infer<typeof effectSchema>; key: string; attempt: number };
export type Input = { state: State; event: Event; facts: Facts };
export type Decision = {
  status: "changed" | "refused";
  reason: string;
  state: State;
  effects: Effect[];
};
export type Decide = (input: Input) => Decision;

export function refuse(state: State, reason: string): Decision {
  return { status: "refused", reason, state, effects: [] };
}

export function changed(state: State, reason: string, effects: Effect[] = []): Decision {
  return { status: "changed", reason, state, effects };
}

export function request(state: State, type: Effect["type"]): Decision {
  const generation = state.generation + 1;
  const effect = { type, key: `assignment:${generation}:${type}`, attempt: 1 };
  return changed(
    {
      ...state,
      generation,
      operation: { status: "pending", effect: type, key: effect.key, attempt: effect.attempt },
    },
    "effect-requested",
    [effect],
  );
}

// Completion and cleanup are result handling, not evidence inferred from host activity.
export function finish(state: State, facts: Facts): Decision {
  const op = state.operation;
  if (op.status === "idle") return refuse(state, "no-operation");
  switch (op.effect) {
    case "merge-pr":
      if (state.completion !== "pr") return refuse(state, "wrong-completion");
      return request({ ...state, phase: "merged" }, "delete-remote-branch");
    case "delete-remote-branch":
      return request(state, "close-pane");
    case "close-pane":
      if (state.completion === "pr") {
        const next = request(state, "remove-worktree");
        if (facts.safeToRemove) return next;
        if (next.state.operation.status === "idle") return refuse(state, "no-operation");
        return changed(
          { ...next.state, operation: { ...next.state.operation, status: "failed" } },
          "unlanded-work",
        );
      }
      return changed({ ...state, operation: { status: "idle" } }, "cleanup-complete");
    case "remove-worktree":
      return changed({ ...state, operation: { status: "idle" } }, "cleanup-complete");
  }
}

export function inspect(decide: Decide, state: State, facts: Facts) {
  const candidates: Event[] = [
    { type: "start" },
    { type: "open-pr" },
    { type: "submit", report: "required-report-reference" },
    { type: "accept" },
    { type: "return", instructions: "required-follow-up" },
    { type: "resume" },
    { type: "merge" },
    { type: "retry" },
    { type: "recover" },
  ];
  const options = candidates.map((event) => ({ event, decision: decide({ state, event, facts }) }));
  return {
    nextActions: options
      .filter(({ decision }) => decision.status === "changed")
      .map(({ event }) => event.type),
    blockers: [
      ...new Set(
        options
          .filter(
            ({ decision }) =>
              decision.status === "refused" &&
              ![
                "invalid-event",
                "invalid-state",
                "wrong-completion",
                "no-operation",
                "follow-up-required",
              ].includes(decision.reason),
          )
          .map(({ decision }) => decision.reason),
      ),
    ],
    waits:
      state.operation.status === "pending"
        ? ["effect-result"]
        : state.operation.status === "unknown"
          ? ["external-evidence"]
          : [],
    needsAttention: facts.worker === "stopped" && ["running", "pr-open"].includes(state.phase),
    dependencyReady:
      state.completion === "pr"
        ? ["pr-open", "merged"].includes(state.phase)
        : state.phase === "completed",
  };
}
