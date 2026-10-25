import { changed, finish, refuse, request, type Decision, type Input } from "./model.ts";

function merge(input: Input): Decision {
  const { state, facts } = input;
  if (state.completion !== "pr" || state.phase !== "pr-open") return refuse(state, "invalid-state");
  if (!facts.approved) return refuse(state, "approval-required");
  if (facts.checks !== "pass") return refuse(state, "checks-not-passing");
  if (!facts.threadsResolved) return refuse(state, "unresolved-threads");
  if (!facts.defaultBase) return refuse(state, "default-base-required");
  return request(state, "merge-pr");
}

function operation(input: Input): Decision {
  const { state, event, facts } = input;
  const op = state.operation;
  if (op.status === "idle") return refuse(state, "no-operation");
  switch (event.type) {
    case "result":
      if (event.key !== op.key || op.status !== "pending") return refuse(state, "stale-result");
      if (event.outcome === "done") return finish(state, facts);
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
      if (facts.observation === "done") return finish(state, facts);
      return changed({ ...state, operation: { ...op, status: "failed" } }, "not-applied");
    case "retry":
      return retry(input);
    default:
      return refuse(state, "operation-pending");
  }
}

function retry(input: Input): Decision {
  const { state, facts } = input;
  const op = state.operation;
  if (op.status !== "failed") return refuse(state, "reconcile-before-retry");
  if (op.effect === "merge-pr") {
    const gate = merge({
      ...input,
      event: { type: "merge" },
      state: { ...state, operation: { status: "idle" } },
    });
    if (gate.status === "refused") return refuse(state, gate.reason);
  }
  if (op.effect === "remove-worktree" && !facts.safeToRemove) return refuse(state, "unlanded-work");
  const effect = { type: op.effect, key: `${op.key}:retry`, attempt: op.attempt + 1 };
  return changed(
    { ...state, operation: { ...op, status: "pending", key: effect.key, attempt: effect.attempt } },
    "retry-requested",
    [effect],
  );
}

function report(input: Input): Decision {
  const { state, event, facts } = input;
  if (state.completion !== "report") return refuse(state, "wrong-completion");
  switch (event.type) {
    case "submit":
      if (state.phase !== "running") return refuse(state, "invalid-state");
      return changed(
        { ...state, phase: "reported", reports: [...state.reports, event.report], followUp: null },
        "report-submitted",
      );
    case "accept":
      if (state.phase !== "reported" || state.followUp !== null)
        return refuse(state, "invalid-state");
      if (facts.actor !== "superagent") return refuse(state, "superagent-required");
      return request({ ...state, phase: "completed" }, "close-pane");
    case "return":
      if (state.phase !== "reported" || state.followUp !== null)
        return refuse(state, "invalid-state");
      if (facts.actor !== "superagent") return refuse(state, "superagent-required");
      return changed({ ...state, followUp: event.instructions }, "follow-up-recorded");
    case "resume":
      if (state.phase !== "reported" || state.followUp === null)
        return refuse(state, "follow-up-required");
      return changed({ ...state, phase: "running" }, "resumed");
    default:
      return refuse(state, "invalid-event");
  }
}

function start(input: Input): Decision {
  const { state, facts } = input;
  if (state.phase !== "ready") return refuse(state, "invalid-state");
  if (!facts.dependenciesReady) return refuse(state, "dependencies-not-ready");
  return changed({ ...state, phase: "running" }, "started");
}

export function decide(input: Input): Decision {
  const { state, event } = input;
  if (state.operation.status !== "idle") return operation(input);
  switch (event.type) {
    case "start":
      return start(input);
    case "open-pr":
      if (state.completion !== "pr" || state.phase !== "running")
        return refuse(state, "invalid-state");
      return changed({ ...state, phase: "pr-open" }, "pr-opened");
    case "merge":
      return merge(input);
    case "submit":
    case "accept":
    case "return":
    case "resume":
      return report(input);
    case "result":
    case "retry":
    case "recover":
      return refuse(state, "no-operation");
  }
}
