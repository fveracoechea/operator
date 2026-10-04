import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { CrewReader } from "./database.ts";
import {
  assignments,
  attemptDispatch,
  gateCheckouts,
  gateRunCommands,
  gateRuns,
} from "./schema.ts";
import { readStored, readStoredValue } from "./stored.ts";

export type GateRunRow = typeof gateRuns.$inferSelect;
export type GateCommandRow = typeof gateRunCommands.$inferSelect;
export type GateCheckoutRow = typeof gateCheckouts.$inferSelect;

/**
 * What one run gates: the integration base, the candidate of one submission on one recorded
 * tip, which is the planned commit of its landing, one place in the rebuilt range of a
 * correction, which the commit and the parent it lands on name, one place in the rebuilt range
 * of the take-out of a source (ADR 0021), or one commit of a branch rebuilt on a new base.
 */
export const gateSubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("base") }),
  z.strictObject({
    kind: z.literal("candidate"),
    assignmentId: z.string(),
    submissionId: z.string(),
    tip: z.string(),
  }),
  z.strictObject({
    kind: z.literal("rewrite"),
    assignmentId: z.string(),
    submissionId: z.string(),
    tip: z.string(),
    parent: z.string(),
  }),
  z.strictObject({
    kind: z.literal("take-out"),
    sourceId: z.string(),
    tip: z.string(),
    parent: z.string(),
  }),
  // One commit of a branch rebuilt on a new base, and the commit it lands on (ADR 0022). The
  // new base itself is gated as a base.
  z.strictObject({ kind: z.literal("rebase"), base: z.string(), parent: z.string() }),
]);

export type GateSubject = z.infer<typeof gateSubjectSchema>;

const declaredCommandSchema = z.strictObject({
  name: z.string(),
  argv: z.array(z.string()),
  timeoutSeconds: z.number(),
});

export type DeclaredCommand = z.infer<typeof declaredCommandSchema>;

/** The commands one run was started with, as the declaration at its key named them. */
export function declaredCommands(run: GateRunRow): DeclaredCommand[] {
  return readStored("gate command list", z.array(declaredCommandSchema), run.commands);
}

/** A key names one tree and one declaration, so a new message or a signature keeps its record. */
export type GateKey = { tree: string; declarationIdentity: string };

/** The one text an approval of a fresh series names the key by. */
export function keyText(key: GateKey): string {
  return `gate-key:${key.tree}:${key.declarationIdentity}`;
}

/** The approval action that starts a fresh series at one key. Only a person grants it. */
export const FRESH_SERIES_ACTION = "gate-fresh-series";

/**
 * The verdict of one key. A key passes only with a passing run and no failed run in its current
 * series, and a pass beside a failure is flaky. Each one except `passed` blocks.
 */
export type KeyStatus =
  | { status: "pending" }
  | { status: "running"; run: GateRunRow }
  | { status: "passed"; passed: GateRunRow[] }
  | { status: "failed"; failed: GateRunRow[] }
  | { status: "flaky"; failed: GateRunRow[]; passed: GateRunRow[] };

function byStart(left: GateRunRow, right: GateRunRow): number {
  return left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id);
}

export function runsAtKey(db: CrewReader, key: GateKey): GateRunRow[] {
  return db
    .select()
    .from(gateRuns)
    .where(
      and(eq(gateRuns.tree, key.tree), eq(gateRuns.declarationIdentity, key.declarationIdentity)),
    )
    .all()
    .toSorted(byStart);
}

/** Every failed run at one key, in every series. A fresh series must answer each of them. */
export function failedRunsAtKey(db: CrewReader, key: GateKey): GateRunRow[] {
  return runsAtKey(db, key).filter((one) => one.state === "failed");
}

export function keyStatus(db: CrewReader, key: GateKey): KeyStatus {
  const runs = runsAtKey(db, key);
  const latest = runs.at(-1);
  if (latest === undefined) {
    return { status: "pending" };
  }

  // A fresh series starts with the run that carries its approval, and earlier runs stay recorded.
  const series = runs.filter((one) => one.series === latest.series);
  const failed = series.filter((one) => one.state === "failed");
  const passed = series.filter((one) => one.state === "passed");
  const running = series.find((one) => one.state === "running");
  if (failed.length > 0 && passed.length > 0) {
    return { status: "flaky", failed, passed };
  }
  if (failed.length > 0) {
    return { status: "failed", failed };
  }
  if (running !== undefined) {
    return { status: "running", run: running };
  }
  return passed.length > 0 ? { status: "passed", passed } : { status: "pending" };
}

/** The five verdicts of a key, which every gated move reads. */
export type GateStatus = KeyStatus["status"];

/** One commit that a gated move gates, under its key. */
export type GatePlace = { commit: string; key: GateKey };

/**
 * Where the project gate stands on a move that gates its places in order: the first place whose
 * key has not passed, with its runs. A running place names its one run, and a move with every
 * place passed names none.
 */
export type GateStep<Place extends GatePlace> =
  | { status: "passed" }
  | (Place & { status: "running"; runIds: [string] })
  | OpenPlace<Place>;

/** A place with no run in progress whose key did not pass. The next run of the move starts on it. */
export type OpenPlace<Place extends GatePlace> =
  | (Place & { status: "pending"; runIds: string[] })
  | (Place & { status: "failed" | "flaky"; runIds: string[] });

/** Gates the places of one move in order, and stops at the first one whose key has not passed. */
export function gateStepOf<Place extends GatePlace>(
  db: CrewReader,
  places: Place[],
): GateStep<Place> {
  for (const place of places) {
    const verdict = keyStatus(db, place.key);
    switch (verdict.status) {
      case "passed":
        continue;
      case "pending":
        return { status: "pending", ...place, runIds: [] };
      case "running":
        return { status: "running", ...place, runIds: [verdict.run.id] };
      default:
        return { status: verdict.status, ...place, runIds: verdict.failed.map((one) => one.id) };
    }
  }
  return { status: "passed" };
}

export function readGateRun(db: CrewReader, runId: string): GateRunRow | null {
  return db.select().from(gateRuns).where(eq(gateRuns.id, runId)).all()[0] ?? null;
}

export function commandsOfRun(db: CrewReader, runId: string): GateCommandRow[] {
  return db
    .select()
    .from(gateRunCommands)
    .where(eq(gateRunCommands.runId, runId))
    .all()
    .toSorted((left, right) => left.position - right.position);
}

export function runningRunOf(db: CrewReader, sourceId: string): GateRunRow | null {
  return (
    db
      .select()
      .from(gateRuns)
      .where(and(eq(gateRuns.sourceId, sourceId), eq(gateRuns.state, "running")))
      .all()[0] ?? null
  );
}

export function checkoutOf(db: CrewReader, sourceId: string): GateCheckoutRow | null {
  return (
    db.select().from(gateCheckouts).where(eq(gateCheckouts.sourceId, sourceId)).all()[0] ?? null
  );
}

/**
 * True when no production attempt of the source has a recorded launch plan. The first one fixes
 * the integration base, so only it waits for a gate run at its base commit.
 */
export function isFirstCodeDispatch(db: CrewReader, sourceId: string): boolean {
  return (
    db
      .select({ attemptId: attemptDispatch.attemptId })
      .from(attemptDispatch)
      .innerJoin(assignments, eq(assignments.id, attemptDispatch.assignmentId))
      .where(and(eq(assignments.sourceId, sourceId), eq(assignments.kind, "production")))
      .all().length === 0
  );
}

/**
 * Where the integration base of one source stands, read from its latest base run, in the states
 * of a gate step. A stopped run proved nothing, so the base stays pending, with the reason it
 * stopped.
 */
export type BaseGate =
  | { status: "pending"; stopped: GateRunRow | null }
  | { status: "running"; run: GateRunRow }
  | { status: "passed"; commit: string; run: GateRunRow }
  | { status: "failed" | "flaky"; commit: string; failed: GateRunRow[] };

export type CandidateGate = (KeyStatus & { commit: string }) | { status: "pending"; commit: null };

/**
 * Where the candidate of one submission on one tip stands. A run at another tip gated another
 * candidate, so it proves nothing here. The verdict is the verdict of the key of the latest run,
 * and a candidate with no run names no commit.
 */
export function candidateGateOf(
  db: CrewReader,
  request: { sourceId: string; submissionId: string; tip: string },
): CandidateGate {
  const runs = db
    .select()
    .from(gateRuns)
    .where(eq(gateRuns.sourceId, request.sourceId))
    .all()
    .filter((one) => {
      const subject = readStored("gate subject", gateSubjectSchema, one.subject);
      return (
        subject.kind === "candidate" &&
        subject.submissionId === request.submissionId &&
        subject.tip === request.tip
      );
    })
    .toSorted(byStart);
  const latest = runs.at(-1);
  if (latest === undefined) {
    return { status: "pending", commit: null };
  }
  return { ...keyStatus(db, latest), commit: latest.commit };
}

export function baseGateOf(db: CrewReader, sourceId: string): BaseGate {
  const runs = db
    .select()
    .from(gateRuns)
    .where(eq(gateRuns.sourceId, sourceId))
    .all()
    .filter((one) => readStored("gate subject", gateSubjectSchema, one.subject).kind === "base")
    .toSorted(byStart);
  const latest = runs.at(-1);
  if (latest === undefined) {
    return { status: "pending", stopped: null };
  }
  if (latest.state === "running") {
    return { status: "running", run: latest };
  }

  const verdict = keyStatus(db, latest);
  if (verdict.status === "passed") {
    return { status: "passed", commit: latest.commit, run: verdict.passed.at(-1) ?? latest };
  }
  if (verdict.status === "failed" || verdict.status === "flaky") {
    return { status: verdict.status, commit: latest.commit, failed: verdict.failed };
  }
  return { status: "pending", stopped: latest.state === "stopped" ? latest : null };
}

/** The states of one gate run, as `gate_runs.state` records them (ADR 0021). */
export const gateRunStateSchema = z.enum(["running", "passed", "failed", "stopped"]);

/** One run as a reader states it. The output stays in its artifact, and only its path is named. */
export function gateRunRecordOf(db: CrewReader, run: GateRunRow) {
  const recorded = commandsOfRun(db, run.id);
  return {
    runId: run.id,
    sourceId: run.sourceId,
    subject: readStored("gate subject", gateSubjectSchema, run.subject),
    key: { tree: run.tree, declarationIdentity: run.declarationIdentity },
    commit: run.commit,
    series: run.series,
    replaces: run.replaces,
    state: readStoredValue("gate run state", gateRunStateSchema, run.state),
    detail: run.detail,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    commands: declaredCommands(run).map((declared, index) => {
      const row = recorded.find((one) => one.position === index) ?? null;
      return {
        name: declared.name,
        argv: declared.argv,
        timeoutSeconds: declared.timeoutSeconds,
        outcome: row?.outcome ?? null,
        exitCode: row?.exitCode ?? null,
        reason: row?.reason ?? null,
        outputPath: row?.outputPath ?? null,
        outputIdentity: row?.outputIdentity ?? null,
      };
    }),
  };
}

export type GateRunRecord = ReturnType<typeof gateRunRecordOf>;
