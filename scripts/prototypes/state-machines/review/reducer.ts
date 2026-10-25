import { changed, finish, refuse, type Decision, type Input } from "./model.ts";

function operation(input: Input): Decision {
  const { state, event, facts } = input;
  const op = state.operation;
  if (op.status === "idle") return refuse(state, "no-operation");
  switch (event.type) {
    case "result":
      if (event.key !== op.effect.key || op.status !== "pending")
        return refuse(state, "stale-result");
      if (event.outcome === "done") return finish(state);
      return changed(
        {
          ...state,
          operation: { ...op, status: event.outcome === "unknown" ? "unknown" : "failed" },
        },
        event.outcome,
      );
    case "recover":
      if (op.status === "failed") return refuse(state, "retry-required");
      if (facts.observation === "unknown") return refuse(state, "outcome-unknown");
      if (facts.observation === "done") return finish(state);
      return changed({ ...state, operation: { ...op, status: "failed" } }, "not-applied");
    case "retry":
      return retry(input);
    default:
      return refuse(state, "operation-pending");
  }
}

function draft(input: Input): Decision {
  const { state, event, facts } = input;
  if (event.type !== "draft" || state.phase !== "reviewing") return refuse(state, "invalid-state");
  if (!facts.draftValid) return refuse(state, "invalid-draft");
  if (event.head !== facts.head && state.headMoves < 3) {
    return changed(
      {
        ...state,
        headMoves: state.headMoves + 1,
        scope: facts.relation === "force-push" ? "full" : "incremental",
      },
      facts.relation === "force-push" ? "review-from-start" : "review-new-commits",
    );
  }
  let reviewEvent: "APPROVE" | "COMMENT" | "REQUEST_CHANGES" = "APPROVE";
  if (event.blockers > 0 || facts.failingCI) reviewEvent = "COMMENT";
  if (event.strongBreach) reviewEvent = "REQUEST_CHANGES";
  if (facts.origin === "assignment" || facts.ownPr) reviewEvent = "COMMENT";
  const effect = {
    type: "post-review",
    key: `review:${state.round}:${state.headMoves}:${event.head}`,
    attempt: 1,
    head: event.head,
    event: reviewEvent,
    headLimitWarning: event.head !== facts.head,
    blockers: event.blockers,
    strongBreach: event.strongBreach,
  } satisfies import("./model.ts").Effect;
  return changed(
    { ...state, phase: "posting", operation: { status: "pending", effect } },
    "effect-requested",
    [effect],
  );
}

function retry(input: Input): Decision {
  const { state, facts } = input;
  const op = state.operation;
  if (op.status !== "failed") return refuse(state, "reconcile-before-retry");
  const next = draft({
    state: { ...state, phase: "reviewing", operation: { status: "idle" } },
    event: {
      type: "draft",
      head: op.effect.head,
      blockers: op.effect.blockers,
      strongBreach: op.effect.strongBreach,
    },
    facts,
  });
  if (next.status === "refused") return refuse(state, next.reason);
  const requested = next.effects[0];
  if (!requested) return next;
  const effect = { ...requested, key: `${op.effect.key}:retry`, attempt: op.effect.attempt + 1 };
  return changed({ ...next.state, operation: { status: "pending", effect } }, "retry-requested", [
    effect,
  ]);
}

function activity(input: Input): Decision {
  const { state, facts } = input;
  if (!["watching", "approved"].includes(state.phase)) return refuse(state, "invalid-state");
  if (facts.activity === "none") return refuse(state, "no-new-activity");
  if (state.phase === "approved" && facts.activity !== "renewed")
    return refuse(state, "approval-stops-watching");
  return changed(
    { ...state, phase: "reviewing", round: state.round + 1, headMoves: 0, scope: "full" },
    "round-started",
  );
}

export function decide(input: Input): Decision {
  const { state, event } = input;
  if (state.operation.status !== "idle") return operation(input);
  switch (event.type) {
    case "start":
      if (state.phase !== "queued") return refuse(state, "invalid-state");
      return changed({ ...state, phase: "reviewing", round: state.round + 1 }, "review-started");
    case "draft":
      return draft(input);
    case "activity":
      return activity(input);
    case "close":
    case "skip":
      if (["closed", "skipped"].includes(state.phase)) return refuse(state, "invalid-state");
      return changed({ ...state, phase: event.type === "close" ? "closed" : "skipped" }, "ended");
    case "retry":
    case "recover":
    case "result":
      return refuse(state, "no-operation");
  }
}
