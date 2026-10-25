import { z } from "zod";

const reviewEvent = z.enum(["APPROVE", "COMMENT", "REQUEST_CHANGES"]);
const postSchema = z.object({
  type: z.literal("post-review"),
  key: z.string(),
  attempt: z.number().int().positive(),
  head: z.string(),
  event: reviewEvent,
  headLimitWarning: z.boolean(),
  blockers: z.number().int().nonnegative(),
  strongBreach: z.boolean(),
});
const operationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("idle") }),
  z.object({ status: z.enum(["pending", "failed", "unknown"]), effect: postSchema }),
]);
export const stateSchema = z.object({
  phase: z.enum(["queued", "reviewing", "posting", "watching", "approved", "closed", "skipped"]),
  round: z.number().int().nonnegative(),
  headMoves: z.number().int().nonnegative(),
  scope: z.enum(["full", "incremental"]),
  operation: operationSchema,
});
export const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start") }),
  z.object({
    type: z.literal("draft"),
    head: z.string().min(1),
    blockers: z.number().int().nonnegative(),
    strongBreach: z.boolean(),
  }),
  z.object({ type: z.literal("activity") }),
  z.object({ type: z.literal("close") }),
  z.object({ type: z.literal("skip") }),
  z.object({ type: z.literal("retry") }),
  z.object({ type: z.literal("recover") }),
  z.object({
    type: z.literal("result"),
    key: z.string(),
    outcome: z.enum(["done", "not-applied", "unknown"]),
  }),
]);
export const factsSchema = z.object({
  head: z.string(),
  relation: z.enum(["same", "fast-forward", "force-push"]),
  draftValid: z.boolean(),
  failingCI: z.boolean(),
  origin: z.enum(["slack", "assignment"]),
  ownPr: z.boolean(),
  activity: z.enum(["none", "commits", "reply", "resolved-thread", "renewed"]),
  observation: z.enum(["done", "not-done", "unknown"]),
  worker: z.enum(["running", "stopped"]),
});
export type State = z.infer<typeof stateSchema>;
export type Event = z.infer<typeof eventSchema>;
export type Facts = z.infer<typeof factsSchema>;
export type Effect = z.infer<typeof postSchema>;
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

export function finish(state: State): Decision {
  if (state.operation.status === "idle") return refuse(state, "no-operation");
  return changed(
    {
      ...state,
      phase: state.operation.effect.event === "APPROVE" ? "approved" : "watching",
      operation: { status: "idle" },
    },
    "review-posted",
  );
}

export function inspect(decide: Decide, state: State, facts: Facts) {
  const candidates: Event[] = [
    { type: "start" },
    { type: "draft", head: facts.head, blockers: 0, strongBreach: false },
    { type: "activity" },
    { type: "close" },
    { type: "skip" },
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
              !["invalid-state", "no-operation"].includes(decision.reason),
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
    needsAttention: facts.worker === "stopped" && state.phase === "reviewing",
  };
}
