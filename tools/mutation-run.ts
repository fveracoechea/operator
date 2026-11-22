import type { MutationUnit } from "./mutation-selection.ts";
import { mutationGuidance } from "./mutation-policy.ts";
import type { MutationProgress } from "./mutation-engine-progress.ts";

type Location = { start: { line: number; column: number }; end: { line: number; column: number } };
export type MutationResult = {
  id: string;
  status: string;
  mutatorName: string;
  location: Location;
  replacement: string;
  statusReason?: string;
};

type Verdict = {
  count: "survivors" | "untested" | "incomplete" | "killed" | "ignored";
} & ({ channel: "log" | "error"; message: string } | { channel: undefined });

type UnitEvidence = {
  name: string;
  tests: string[];
  patterns: string[];
  status: "unrun" | "running" | "passed" | "failed" | "interrupted" | "reused";
  mutants: MutationResult[] | null;
  progress: MutationProgress;
  error?: string;
};
export type MutationEvent = {
  version: 1;
  runId: string;
  sequence: number;
  type:
    | "run-started"
    | "unit-started"
    | "progress"
    | "unit-completed"
    | "unit-interrupted"
    | "run-completed";
  elapsedMs: number;
  state: {
    status: "running" | "passed" | "failed" | "incomplete";
    activeUnit: string | null;
    completedUnits: number;
    skipped: number;
    units: UnitEvidence[];
  };
};

type RunOptions = {
  keepGoing?: boolean;
  runId?: string;
  now?: () => number;
  event?: (event: MutationEvent) => void;
  progressIntervalMs?: number;
};
type Counts = Record<Verdict["count"], number>;
type Output = { log: (line: string) => void; error: (line: string) => void };

function campaignVerdict(counts: Counts): {
  status: "passed" | "failed" | "incomplete";
  code: number;
} {
  if (counts.incomplete > 0) return { status: "incomplete", code: 3 };
  if (counts.survivors + counts.untested > 0) return { status: "failed", code: 2 };
  return { status: "passed", code: 0 };
}

function recordResults(
  unit: MutationUnit,
  mutants: MutationResult[],
  counts: Counts,
  output: Output,
): "passed" | "failed" {
  let status: "passed" | "failed" = "passed";
  for (const mutant of mutants) {
    const verdict = mutationVerdict(unit, mutant);
    counts[verdict.count]++;
    if (verdict.channel) output[verdict.channel](verdict.message);
    if (
      verdict.count === "survivors" ||
      verdict.count === "untested" ||
      verdict.count === "incomplete"
    )
      status = "failed";
  }
  return status;
}

function originalText(source: string, { start, end }: Location): string {
  // Stryker results use one-based report locations, including columns.
  return source
    .split("\n")
    .slice(start.line - 1, end.line)
    .map((line, index) =>
      line.slice(
        index === 0 ? start.column - 1 : 0,
        start.line + index === end.line ? end.column - 1 : undefined,
      ),
    )
    .join("\n")
    .replaceAll("\n", "\\n")
    .replaceAll("`", "\\`");
}

function mutationVerdict(unit: MutationUnit, mutant: MutationResult): Verdict {
  const location = `${unit.name}:${mutant.location.start.line}`;
  if (mutant.status === "NoCoverage")
    return {
      count: "untested",
      channel: "log",
      message: `${location}: untested: ${mutant.mutatorName}`,
    };
  if (mutant.status === "Survived")
    return {
      count: "survivors",
      channel: "log",
      message: `${location}: survived: ${mutant.mutatorName}: \`${originalText(unit.source, mutant.location)}\` to \`${mutant.replacement.replaceAll("\n", "\\n").replaceAll("`", "\\`")}\``,
    };
  if (mutant.status === "Killed") return { count: "killed", channel: undefined };
  if (mutant.status === "Ignored")
    return {
      count: "ignored",
      channel: "log",
      message: JSON.stringify({
        unit: unit.name,
        id: mutant.id,
        status: mutant.status,
        mutatorName: mutant.mutatorName,
        location: mutant.location,
        replacement: mutant.replacement,
        original: originalText(unit.source, mutant.location),
        statusReason: mutant.statusReason,
      }),
    };
  // A timeout, runtime error, compile error, or pending result has no verdict.
  return {
    count: "incomplete",
    channel: "error",
    message: `${location}: incomplete: ${mutant.status}: ${mutant.statusReason ?? "no result"}`,
  };
}

export async function runMutationUnits(
  selected: { units: MutationUnit[]; skipped: number },
  execute: (
    unit: MutationUnit,
    progress: (progress: MutationProgress) => void,
  ) => Promise<MutationResult[]>,
  output: Output,
  options: RunOptions = {},
): Promise<number> {
  const counts = { survivors: 0, untested: 0, incomplete: 0, killed: 0, ignored: 0 };
  const now = options.now ?? Date.now;
  const started = now();
  const runId = options.runId ?? crypto.randomUUID();
  let sequence = 0;
  const work = selected.units.map<{ unit: MutationUnit; evidence: UnitEvidence }>((unit) => ({
    unit,
    evidence: {
      name: unit.name,
      tests: unit.tests,
      patterns: unit.patterns,
      status: "unrun",
      mutants: null,
      progress: { completed: 0, total: null, reused: 0 },
    },
  }));
  const state: MutationEvent["state"] = {
    status: "running",
    activeUnit: null,
    completedUnits: 0,
    skipped: selected.skipped,
    units: work.map(({ evidence }) => evidence),
  };
  function publish(type: MutationEvent["type"]) {
    options.event?.({
      version: 1,
      runId,
      sequence: sequence++,
      type,
      elapsedMs: now() - started,
      state: structuredClone(state),
    });
  }

  publish("run-started");
  for (const { unit, evidence } of work) {
    evidence.status = "running";
    state.activeUnit = unit.name;
    publish("unit-started");
    if (unit.tests.length === 0) {
      output.log(`${unit.name}: untested. Add a direct beside-test.`);
      counts.untested++;
      evidence.status = "failed";
    } else {
      const heartbeat = setInterval(() => publish("progress"), options.progressIntervalMs ?? 1000);
      let mutants: MutationResult[];
      try {
        mutants = await execute(unit, (progress) => {
          evidence.progress = progress;
          publish("progress");
        });
      } catch (error) {
        evidence.status = "interrupted";
        evidence.error = String(error);
        state.activeUnit = null;
        publish("unit-interrupted");
        if (options.keepGoing) {
          counts.incomplete++;
          output.error(`Mutation execution incomplete: ${String(error)}`);
          continue;
        }
        state.status = "incomplete";
        publish("run-completed");
        return await Promise.reject(error);
      } finally {
        clearInterval(heartbeat);
      }
      evidence.mutants = mutants;
      evidence.progress = {
        ...evidence.progress,
        completed: mutants.length,
        total: mutants.length,
      };
      evidence.status = recordResults(unit, mutants, counts, output);
    }
    state.completedUnits++;
    state.activeUnit = null;
    publish("unit-completed");
    if (!options.keepGoing && evidence.status === "failed") break;
  }
  const verdict = campaignVerdict(counts);
  state.status = verdict.status;
  publish("run-completed");
  output.log(
    `Mutation summary: ${counts.survivors} survivors, ${counts.untested} untested, ${counts.incomplete} incomplete, ${counts.killed} killed, ${counts.ignored} ignored, ${selected.skipped} skipped. See ${mutationGuidance}.`,
  );
  return verdict.code;
}
