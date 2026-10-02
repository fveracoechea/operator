import type { GateUnusable } from "./dispatch-context.ts";
import type { AttemptContext } from "./dispatch.ts";
import type { GateRead } from "./result-checks.ts";
import { readGateKey } from "./gate-start.ts";
import { type GateKey, isFirstCodeDispatch, keyStatus } from "./gate-runs.ts";
import { readState, type StateFailure } from "./operations.ts";

/** The refusal names of a base that has not passed, members of the durable unions of ADR 0011. */
export type BaseGateName = "gate_pending" | "gate_running" | "gate_failed" | "gate_flaky";

export type BaseGateRefusal = {
  status: "base-gate-not-passed";
  attemptId: string;
  gate: BaseGateName;
  commit: string;
  key: GateKey;
  // The failed runs a failed or flaky key holds, or the run that still runs.
  runIds: string[];
};

/** The base that passed, with the gate declaration it fixes on the source. */
export type BasePassed = { commit: string; gate: Extract<GateRead, { status: "declared" }> };

export type BaseUnread =
  | { status: "base-commit-unread"; attemptId: string; commit: string; detail: string }
  | GateUnusable;

/**
 * The first code dispatch of a source fixes its integration base, so it starts only from a commit
 * whose key passed the project gate (ADR 0021). A failing base is not fixed, and the refusal
 * names the commit and the failed run. A later dispatch of the source reads no base gate here.
 * A base that passed is returned, so the dispatch creates the integration branch at it.
 */
export async function checkBaseGate(request: {
  projectRoot: string;
  context: AttemptContext;
  attemptId: string;
  baseCommit: string;
}): Promise<
  { status: "ok"; base: BasePassed | null } | BaseGateRefusal | BaseUnread | StateFailure
> {
  const { assignment } = request.context;
  if (assignment.kind !== "production") {
    return { status: "ok", base: null };
  }
  const first = await readState(request.projectRoot, (db) =>
    isFirstCodeDispatch(db, assignment.sourceId),
  );
  if (first !== true) {
    return first === false ? { status: "ok", base: null } : first;
  }

  // The brief read this gate already, so only a commit that vanished since then is unread here.
  const keyed = await readGateKey({ projectRoot: request.projectRoot, commit: request.baseCommit });
  if (keyed.status === "commit-unread") {
    return {
      status: "base-commit-unread",
      attemptId: request.attemptId,
      commit: keyed.commit,
      detail: keyed.detail,
    };
  }
  if (keyed.status !== "read") {
    return { status: "project-gate-unusable", attemptId: request.attemptId, gate: keyed.gate };
  }
  const { key } = keyed;
  const verdict = await readState(request.projectRoot, (db) => keyStatus(db, key));
  if ("status" in verdict && verdict.status === "passed") {
    return { status: "ok", base: { commit: keyed.gate.commit, gate: keyed.gate } };
  }
  const refusal = (gate: BaseGateName, runIds: string[]): BaseGateRefusal => ({
    status: "base-gate-not-passed",
    attemptId: request.attemptId,
    gate,
    commit: keyed.gate.commit,
    key,
    runIds,
  });
  switch (verdict.status) {
    case "pending":
      return refusal("gate_pending", []);
    case "running":
      return refusal("gate_running", [verdict.run.id]);
    case "failed":
      return refusal(
        "gate_failed",
        verdict.failed.map((one) => one.id),
      );
    case "flaky":
      return refusal(
        "gate_flaky",
        verdict.failed.map((one) => one.id),
      );
    default:
      return verdict;
  }
}
