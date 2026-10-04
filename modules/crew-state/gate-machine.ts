import type { z } from "zod";
import { type ApprovalRow, approvalCovers } from "./approvals.ts";
import {
  type DeclaredCommand,
  FRESH_SERIES_ACTION,
  type GateKey,
  type GateRunRow,
  gateRunStateSchema,
  type KeyStatus,
  keyText,
} from "./gate-runs.ts";

/**
 * The gate run machine (ADR 0021). One `gate_runs` row starts `running` and ends `passed`,
 * `failed`, or `stopped`. The verdict of its key is read from the series, as `KeyStatus`.
 */
export type GateRunState = z.infer<typeof gateRunStateSchema>;

/**
 * The events that move one run. A start records a new run, a begin is the first write of its
 * runner, a command records one outcome, a stop ends a run with no outcome, and a replace stops
 * a run whose runner stopped, so a new run of the source can start.
 */
export type GateRunEvent = "start" | "begin" | "command" | "stop" | "replace";

/** Whether a process in the pane of a running run still names it. */
export type RunnerRead =
  | { status: "live" }
  | { status: "stopped" }
  | { status: "unknown"; detail: string };

/** The outcome of one command, as its runner reports it. */
export type CommandOutcome = {
  position: number;
  outcome: "passed" | "failed";
  exitCode: number | null;
  reason: "timed-out" | null;
  outputPath: string;
  outputIdentity: string;
};

/** The request of a fresh series, as the person approves it: the key and every failed run. */
export type FreshSeriesRequest = {
  action: string;
  targets: string[];
  scope: string;
  requestRevision: string;
};

type RunFacts = { run: GateRunRow };

/** What each event reads before it decides. The caller gathers these facts. */
export type GateRunFacts = {
  start: {
    sourceId: string;
    key: GateKey;
    commit: string;
    /** The run of the source with no outcome, and whether its runner still runs. */
    running: { run: GateRunRow; runner: RunnerRead } | null;
    verdict: KeyStatus;
    /** Every failed run at the key, in every series. */
    failed: string[];
    /** The approval of a fresh series that the request names, as it is recorded. */
    approval: { id: string; row: ApprovalRow | null } | null;
  };
  begin: RunFacts;
  command: RunFacts & {
    command: CommandOutcome;
    declared: DeclaredCommand[];
    /** How many commands of the run have an outcome already. */
    recorded: number;
  };
  stop: RunFacts;
  replace: RunFacts;
};

type NotRunning = { status: "gate-run-not-running"; runId: string; state: string };

/** The refusals of each event. */
export type GateRunRefusal = {
  start:
    | { status: "gate-runner-unknown"; runId: string; detail: string }
    | { status: "gate-running"; runId: string; detail: string }
    | { status: "gate-passed"; key: GateKey; commit: string; runIds: string[] }
    | { status: "fresh-series-not-needed"; key: GateKey }
    | {
        status: "fresh-series-not-approved";
        key: GateKey;
        request: FreshSeriesRequest;
        found: string;
      };
  begin: NotRunning | { status: "gate-run-begun"; runId: string };
  command:
    | NotRunning
    | { status: "gate-run-not-begun"; runId: string }
    | { status: "gate-command-out-of-order"; runId: string; expected: number; position: number };
  stop: NotRunning;
  replace: NotRunning;
};

/** What each event moves to. A start names the run it replaces and the series it opens. */
export type GateRunNext = {
  start: { state: "running"; replaces: string | null; series: string | null };
  begin: "running";
  command: "running" | "passed" | "failed";
  stop: "stopped";
  replace: "stopped";
};

type Guard<F, R> = (facts: F) => R | null;

/** Only a run with no outcome takes a runner write, a stop, or a replace. */
const running: Guard<RunFacts, NotRunning> = ({ run }) =>
  run.state === "running"
    ? null
    : { status: "gate-run-not-running", runId: run.id, state: run.state };

/** The request of a fresh series at the key of one start. */
function freshSeriesOf(facts: GateRunFacts["start"]): FreshSeriesRequest {
  const keyName = keyText(facts.key);
  return {
    action: FRESH_SERIES_ACTION,
    targets: [keyName, ...facts.failed],
    scope: facts.sourceId,
    requestRevision: keyName,
  };
}

type StartGuard = Guard<GateRunFacts["start"], GateRunRefusal["start"]>;

/** The recorded start rules, in order. */
const START_GUARDS: StartGuard[] = [
  // A run with no outcome is replaced only after its pane shows that the runner stopped.
  ({ running: held }) =>
    held?.runner.status === "unknown"
      ? { status: "gate-runner-unknown", runId: held.run.id, detail: held.runner.detail }
      : null,
  // One gate run of a source runs at a time.
  ({ running: held }) =>
    held?.runner.status === "live"
      ? {
          status: "gate-running",
          runId: held.run.id,
          detail: `Gate run ${held.run.id} of this source is still running at commit ${held.run.commit}.`,
        }
      : null,
  ({ verdict, key, commit }) =>
    verdict.status === "passed"
      ? { status: "gate-passed", key, commit, runIds: verdict.passed.map((one) => one.id) }
      : null,
  // Only a person starts a fresh series, with an approval that names the key and every failed run.
  ({ approval, failed, key }) =>
    approval !== null && failed.length === 0 ? { status: "fresh-series-not-needed", key } : null,
  (facts) => {
    if (facts.approval === null) {
      return null;
    }
    const { id, row } = facts.approval;
    const request = freshSeriesOf(facts);
    const coverage = row === null ? null : approvalCovers(row, request);
    if (coverage?.status === "covers") {
      return null;
    }
    const found =
      coverage === null
        ? `No approval ${id} is recorded.`
        : coverage.status === "revoked"
          ? `Approval ${id} was revoked.`
          : `Approval ${id} does not match the ${coverage.field}.`;
    return { status: "fresh-series-not-approved", key: facts.key, request, found };
  },
];

type Entry<E extends GateRunEvent> = {
  guards: Array<Guard<GateRunFacts[E], GateRunRefusal[E]>>;
  next: (facts: GateRunFacts[E]) => GateRunNext[E];
};

/** The transition table of a gate run: the guards of each event in order, and the next state. */
const GATE_RUN_TABLE: { [E in GateRunEvent]: Entry<E> } = {
  start: {
    guards: START_GUARDS,
    next: ({ running: held, approval }) => ({
      state: "running",
      replaces: held === null ? null : held.run.id,
      series: approval === null ? null : approval.id,
    }),
  },
  // A second runner on the same run is refused here.
  begin: {
    guards: [
      running,
      ({ run }) => (run.begunAt === null ? null : { status: "gate-run-begun", runId: run.id }),
    ],
    next: () => "running",
  },
  // Commands are recorded in order. A failure fails the run, and the last pass passes it.
  command: {
    guards: [
      running,
      ({ run }) => (run.begunAt === null ? { status: "gate-run-not-begun", runId: run.id } : null),
      ({ run, command, declared, recorded }) =>
        command.position === recorded && declared[command.position] !== undefined
          ? null
          : {
              status: "gate-command-out-of-order",
              runId: run.id,
              expected: recorded,
              position: command.position,
            },
    ],
    next: ({ command, declared }) =>
      command.outcome === "failed" || command.position === declared.length - 1
        ? command.outcome
        : "running",
  },
  stop: { guards: [running], next: () => "stopped" },
  replace: { guards: [running], next: () => "stopped" },
};

export const GateRun = {
  /**
   * Decides one event on one gate run. It is pure: it reads only the facts the caller gathered,
   * and it returns the first refusal in the order of the table, or the next state.
   */
  decide<E extends GateRunEvent>(
    event: E,
    facts: GateRunFacts[E],
  ): { refused: GateRunRefusal[E] } | { next: GateRunNext[E] } {
    const entry: Entry<E> = GATE_RUN_TABLE[event];
    for (const guard of entry.guards) {
      const refused = guard(facts);
      if (refused !== null) {
        return { refused };
      }
    }
    return { next: entry.next(facts) };
  },
};
