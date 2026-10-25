import { decideStateTransition, type StateTransitionRule } from "../state-machine.ts";
import { changed, finish, refuse, request, type Decision, type Input } from "./model.ts";

const operationRules: readonly StateTransitionRule<Input, Decision>[] = [
  {
    name: "correlate-result",
    decide({ state, event, facts }) {
      if (event.type !== "result" || state.operation.status === "idle") return;
      if (event.key !== state.operation.key || state.operation.status !== "pending")
        return refuse(state, "stale-result");
      if (event.outcome === "done") return finish(state, facts);
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
      if (facts.observation === "done") return finish(state, facts);
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
      const op = state.operation;
      if (op.status !== "failed") return refuse(state, "reconcile-before-retry");
      if (op.effect === "merge-pr") {
        const input: Input = {
          state: { ...state, operation: { status: "idle" } },
          event: { type: "merge" },
          facts,
        };
        const gate = decideStateTransition(mergeRules, input, refuse(state, "invalid-event"));
        if (gate.status === "refused") return refuse(state, gate.reason);
      }
      if (op.effect === "remove-worktree" && !facts.safeToRemove)
        return refuse(state, "unlanded-work");
      const effect = { type: op.effect, key: `${op.key}:retry`, attempt: op.attempt + 1 };
      return changed(
        {
          ...state,
          operation: { ...op, status: "pending", key: effect.key, attempt: effect.attempt },
        },
        "retry-requested",
        [effect],
      );
    },
  },
];

const reportRules: readonly StateTransitionRule<Input, Decision>[] = [
  {
    name: "submit-durable-report",
    decide({ state, event }) {
      if (event.type !== "submit" || state.completion !== "report") return;
      if (state.phase !== "running") return refuse(state, "invalid-state");
      return changed(
        { ...state, phase: "reported", reports: [...state.reports, event.report], followUp: null },
        "report-submitted",
      );
    },
  },
  {
    name: "superagent-disposition",
    decide({ state, event, facts }) {
      if (state.completion !== "report" || (event.type !== "accept" && event.type !== "return"))
        return;
      if (state.phase !== "reported" || state.followUp !== null)
        return refuse(state, "invalid-state");
      if (facts.actor !== "superagent") return refuse(state, "superagent-required");
      if (event.type === "return")
        return changed({ ...state, followUp: event.instructions }, "follow-up-recorded");
      return request({ ...state, phase: "completed" }, "close-pane");
    },
  },
  {
    name: "resume-returned-work",
    decide({ state, event }) {
      if (event.type !== "resume" || state.completion !== "report") return;
      if (state.phase !== "reported" || state.followUp === null)
        return refuse(state, "follow-up-required");
      return changed({ ...state, phase: "running" }, "resumed");
    },
  },
];

const mergeRules: readonly StateTransitionRule<Input, Decision>[] = [
  {
    name: "open-pr-only",
    decide({ state }) {
      if (state.completion !== "pr" || state.phase !== "pr-open")
        return refuse(state, "invalid-state");
    },
  },
  {
    name: "approval",
    decide({ state, facts }) {
      if (!facts.approved) return refuse(state, "approval-required");
    },
  },
  {
    name: "passing-checks",
    decide({ state, facts }) {
      if (facts.checks !== "pass") return refuse(state, "checks-not-passing");
    },
  },
  {
    name: "resolved-threads",
    decide({ state, facts }) {
      if (!facts.threadsResolved) return refuse(state, "unresolved-threads");
    },
  },
  {
    name: "default-base",
    decide({ state, facts }) {
      if (!facts.defaultBase) return refuse(state, "default-base-required");
    },
  },
  {
    name: "request-merge",
    decide({ state }) {
      return request(state, "merge-pr");
    },
  },
];

const rules: readonly StateTransitionRule<Input, Decision>[] = [
  {
    name: "pending-operation-first",
    decide(input) {
      if (input.state.operation.status === "idle") return;
      return decideStateTransition(operationRules, input, refuse(input.state, "operation-pending"));
    },
  },
  {
    name: "start-ready-assignment",
    decide({ state, event, facts }) {
      if (event.type !== "start") return;
      if (state.phase !== "ready") return refuse(state, "invalid-state");
      if (!facts.dependenciesReady) return refuse(state, "dependencies-not-ready");
      return changed({ ...state, phase: "running" }, "started");
    },
  },
  {
    name: "record-open-pr",
    decide({ state, event }) {
      if (event.type !== "open-pr") return;
      if (state.completion !== "pr" || state.phase !== "running")
        return refuse(state, "invalid-state");
      return changed({ ...state, phase: "pr-open" }, "pr-opened");
    },
  },
  {
    name: "ordered-merge-gate",
    decide(input) {
      if (input.event.type !== "merge") return;
      return decideStateTransition(mergeRules, input, refuse(input.state, "invalid-event"));
    },
  },
  {
    name: "report-completion-only",
    decide(input) {
      if (!["submit", "accept", "return", "resume"].includes(input.event.type)) return;
      if (input.state.completion !== "report") return refuse(input.state, "wrong-completion");
      return decideStateTransition(reportRules, input, refuse(input.state, "invalid-event"));
    },
  },
];

export function decide(input: Input): Decision {
  return decideStateTransition(rules, input, refuse(input.state, "no-operation"));
}
