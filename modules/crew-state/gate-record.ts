import { eq } from "drizzle-orm";
import type { CrewWriter } from "./database.ts";
import { mutate, readState, type RequestFailure, type StateFailure } from "./operations.ts";
import {
  commandsOfRun,
  declaredCommands,
  type GateRunRecord,
  type GateRunRow,
  gateRunRecordOf,
  readGateRun,
} from "./gate-runs.ts";
import { gateRunCommands, gateRuns } from "./schema.ts";

type Located = { projectRoot: string };

export type RunnerRefusal =
  | { status: "unknown-gate-run"; runId: string }
  | { status: "gate-run-not-running"; runId: string; state: string }
  | { status: "gate-run-begun"; runId: string }
  | { status: "gate-run-not-begun"; runId: string }
  | { status: "gate-command-out-of-order"; runId: string; expected: number; position: number };

export type CommandOutcome = {
  position: number;
  outcome: "passed" | "failed";
  exitCode: number | null;
  reason: "timed-out" | null;
  outputPath: string;
  outputIdentity: string;
};

type Written =
  | { status: "recorded"; run: GateRunRecord }
  | RunnerRefusal
  | StateFailure
  | RequestFailure;

/**
 * Runs one runner write under the owner that started the run. The runner carries no token of
 * its own, so a takeover makes every later write of the former runner stale.
 */
async function asRunOwner(
  request: Located & { runId: string; step: string; input: unknown },
  body: (context: { tx: CrewWriter; run: GateRunRow; now: string }) => RunnerRefusal | null,
): Promise<Written> {
  const found = await readState(request.projectRoot, (db) => {
    const run = readGateRun(db, request.runId);
    return run === null
      ? { status: "unknown-gate-run" as const, runId: request.runId }
      : { status: "found" as const, run };
  });
  if (found.status !== "found") {
    return found;
  }

  const { result } = await mutate<{ status: "recorded"; run: GateRunRecord } | RunnerRefusal>(
    {
      projectRoot: request.projectRoot,
      requestId: `${request.runId}#${request.step}`,
      ownerToken: found.run.ownerToken,
      now: new Date().toISOString(),
      operation: `gate_run_${request.step.split(".")[0]}`,
      input: request.input,
    },
    ({ tx, now }) => {
      const run = readGateRun(tx, request.runId);
      if (run === null) {
        return { commit: false, outcome: { status: "unknown-gate-run", runId: request.runId } };
      }
      if (run.state !== "running") {
        return {
          commit: false,
          outcome: { status: "gate-run-not-running", runId: run.id, state: run.state },
        };
      }
      const refused = body({ tx, run, now });
      if (refused !== null) {
        return { commit: false, outcome: refused };
      }
      const after = readGateRun(tx, request.runId) ?? run;
      return { commit: true, outcome: { status: "recorded", run: gateRunRecordOf(tx, after) } };
    },
  );
  return result;
}

/** The first write of a runner. A second runner on the same run is refused here. */
export async function beginGateRun(request: Located & { runId: string }): Promise<Written> {
  return asRunOwner(
    { ...request, step: "begin", input: { runId: request.runId } },
    ({ tx, run, now }) => {
      if (run.begunAt !== null) {
        return { status: "gate-run-begun", runId: run.id };
      }
      tx.update(gateRuns).set({ begunAt: now }).where(eq(gateRuns.id, run.id)).run();
      return null;
    },
  );
}

/**
 * Records the outcome of one command, in order. A failure records every later command as
 * `not-run` and fails the run. The last pass passes the run. Nothing here reads pane text.
 */
export async function recordGateCommand(
  request: Located & { runId: string; command: CommandOutcome },
): Promise<Written> {
  const { command } = request;
  return asRunOwner(
    { ...request, step: `command.${command.position}`, input: command },
    ({ tx, run, now }) => {
      if (run.begunAt === null) {
        return { status: "gate-run-not-begun", runId: run.id };
      }
      const expected = commandsOfRun(tx, run.id).length;
      const declared = declaredCommands(run);
      if (command.position !== expected || declared[command.position] === undefined) {
        return {
          status: "gate-command-out-of-order",
          runId: run.id,
          expected,
          position: command.position,
        };
      }

      const rows = declared.flatMap((one, position): Array<typeof gateRunCommands.$inferInsert> => {
        const base = {
          runId: run.id,
          position,
          name: one.name,
          argv: JSON.stringify(one.argv),
          timeoutSeconds: one.timeoutSeconds,
          recordedAt: now,
        };
        if (position === command.position) {
          return [
            {
              ...base,
              outcome: command.outcome,
              exitCode: command.exitCode,
              reason: command.reason,
              outputPath: command.outputPath,
              outputIdentity: command.outputIdentity,
            },
          ];
        }
        // After a failure, each later command is `not-run`, so no command is left unaccounted.
        return position > command.position && command.outcome === "failed"
          ? [
              {
                ...base,
                outcome: "not-run",
                exitCode: null,
                reason: null,
                outputPath: null,
                outputIdentity: null,
              },
            ]
          : [];
      });
      tx.insert(gateRunCommands).values(rows).run();

      const last = command.position === declared.length - 1;
      if (command.outcome === "failed" || last) {
        tx.update(gateRuns)
          .set({ state: command.outcome, finishedAt: now })
          .where(eq(gateRuns.id, run.id))
          .run();
      }
      return null;
    },
  );
}

/**
 * Records that the runner stopped before an outcome, for example when the checkout could not be
 * prepared. The run proves nothing, and a new run may start at once.
 */
export async function stopGateRun(
  request: Located & { runId: string; detail: string },
): Promise<Written> {
  return asRunOwner(
    { ...request, step: "stop", input: { detail: request.detail } },
    ({ tx, run }) => {
      tx.update(gateRuns)
        .set({ state: "stopped", detail: request.detail })
        .where(eq(gateRuns.id, run.id))
        .run();
      return null;
    },
  );
}
