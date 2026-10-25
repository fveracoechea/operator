import { firstMatch, type Rule } from "../first-match.ts";
import { changed, finish, refuse, type Decision, type Effect, type Input } from "./model.ts";

const operationRules: readonly Rule<Input, Decision>[] = [
  {
    name: "correlate-result",
    decide({ state, event }) {
      if (event.type !== "result" || state.operation.status === "idle") return;
      if (event.key !== state.operation.effect.key || state.operation.status !== "pending")
        return refuse(state, "stale-result");
      if (event.outcome === "done") return finish(state);
      return changed(
        {
          ...state,
          operation: {
            ...state.operation,
            status: event.outcome === "unknown" ? "unknown" : "failed",
          },
        },
        event.outcome,
      );
    },
  },
  {
    name: "reconcile-before-retry",
    decide({ state, event, facts }) {
      if (event.type !== "recover" || state.operation.status === "idle") return;
      if (state.operation.status === "failed") return refuse(state, "retry-required");
      if (facts.observation === "unknown") return refuse(state, "outcome-unknown");
      if (facts.observation === "done") return finish(state);
      return changed(
        { ...state, operation: { ...state.operation, status: "failed" } },
        "not-applied",
      );
    },
  },
  {
    name: "retry-definite-failure",
    decide({ state, event, facts }) {
      if (event.type !== "retry" || state.operation.status === "idle") return;
      return retry({ state, event, facts });
    },
  },
];

const draftRules: readonly Rule<Input, Decision>[] = [
  {
    name: "reviewing-only",
    decide({ state }) {
      if (state.phase !== "reviewing") return refuse(state, "invalid-state");
    },
  },
  {
    name: "validate-before-post",
    decide({ state, facts }) {
      if (!facts.draftValid) return refuse(state, "invalid-draft");
    },
  },
  {
    name: "head-move-before-post",
    decide({ state, event, facts }) {
      if (event.type !== "draft" || event.head === facts.head || state.headMoves >= 3) return;
      return changed(
        {
          ...state,
          headMoves: state.headMoves + 1,
          scope: facts.relation === "force-push" ? "full" : "incremental",
        },
        facts.relation === "force-push" ? "review-from-start" : "review-new-commits",
      );
    },
  },
  {
    name: "compute-event-and-post",
    decide({ state, event, facts }) {
      if (event.type !== "draft") return;
      const reviewEvent: Effect["event"] =
        facts.origin === "assignment" || facts.ownPr
          ? "COMMENT"
          : event.strongBreach
            ? "REQUEST_CHANGES"
            : event.blockers > 0 || facts.failingCI
              ? "COMMENT"
              : "APPROVE";
      const effect: Effect = {
        type: "post-review",
        key: `review:${state.round}:${state.headMoves}:${event.head}`,
        attempt: 1,
        head: event.head,
        event: reviewEvent,
        headLimitWarning: event.head !== facts.head,
        blockers: event.blockers,
        strongBreach: event.strongBreach,
      };
      return changed(
        { ...state, phase: "posting", operation: { status: "pending", effect } },
        "effect-requested",
        [effect],
      );
    },
  },
];

function retry(input: Input): Decision {
  const { state, facts } = input;
  const op = state.operation;
  if (op.status !== "failed") return refuse(state, "reconcile-before-retry");
  const next = firstMatch(
    draftRules,
    {
      state: { ...state, phase: "reviewing", operation: { status: "idle" } },
      event: {
        type: "draft",
        head: op.effect.head,
        blockers: op.effect.blockers,
        strongBreach: op.effect.strongBreach,
      },
      facts,
    } satisfies Input,
    refuse(state, "invalid-state"),
  );
  if (next.status === "refused") return refuse(state, next.reason);
  const requested = next.effects[0];
  if (!requested) return next;
  const effect = { ...requested, key: `${op.effect.key}:retry`, attempt: op.effect.attempt + 1 };
  return changed({ ...next.state, operation: { status: "pending", effect } }, "retry-requested", [
    effect,
  ]);
}

const rules: readonly Rule<Input, Decision>[] = [
  {
    name: "pending-post-first",
    decide(input) {
      if (input.state.operation.status === "idle") return;
      return firstMatch(operationRules, input, refuse(input.state, "operation-pending"));
    },
  },
  {
    name: "start-queued-request",
    decide({ state, event }) {
      if (event.type !== "start") return;
      if (state.phase !== "queued") return refuse(state, "invalid-state");
      return changed({ ...state, phase: "reviewing", round: state.round + 1 }, "review-started");
    },
  },
  {
    name: "ordered-draft-rules",
    decide(input) {
      if (input.event.type !== "draft") return;
      return firstMatch(draftRules, input, refuse(input.state, "invalid-state"));
    },
  },
  {
    name: "renew-round",
    decide({ state, event, facts }) {
      if (event.type !== "activity") return;
      if (!["watching", "approved"].includes(state.phase)) return refuse(state, "invalid-state");
      if (facts.activity === "none") return refuse(state, "no-new-activity");
      if (state.phase === "approved" && facts.activity !== "renewed")
        return refuse(state, "approval-stops-watching");
      return changed(
        { ...state, phase: "reviewing", round: state.round + 1, headMoves: 0, scope: "full" },
        "round-started",
      );
    },
  },
  {
    name: "end-request",
    decide({ state, event }) {
      if (event.type !== "close" && event.type !== "skip") return;
      if (["closed", "skipped"].includes(state.phase)) return refuse(state, "invalid-state");
      return changed({ ...state, phase: event.type === "close" ? "closed" : "skipped" }, "ended");
    },
  },
];

export function decide(input: Input): Decision {
  return firstMatch(rules, input, refuse(input.state, "no-operation"));
}
