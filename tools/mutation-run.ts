import type { MutationUnit } from "./mutation-selection.ts";
import { mutationGuidance } from "./mutation-policy.ts";

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
  execute: (unit: MutationUnit) => Promise<MutationResult[]>,
  output: { log: (line: string) => void; error: (line: string) => void },
): Promise<number> {
  const counts = { survivors: 0, untested: 0, incomplete: 0, killed: 0, ignored: 0 };
  for (const unit of selected.units) {
    if (unit.tests.length === 0) {
      output.log(`${unit.name}: untested. Add a direct beside-test.`);
      counts.untested++;
    } else {
      const mutants = await execute(unit);
      for (const mutant of mutants) {
        const verdict = mutationVerdict(unit, mutant);
        counts[verdict.count]++;
        if (verdict.channel) output[verdict.channel](verdict.message);
      }
    }
  }
  output.log(
    `Mutation summary: ${counts.survivors} survivors, ${counts.untested} untested, ${counts.incomplete} incomplete, ${counts.killed} killed, ${counts.ignored} ignored, ${selected.skipped} skipped. See ${mutationGuidance}.`,
  );
  if (counts.incomplete > 0) return 3;
  return counts.survivors + counts.untested > 0 ? 2 : 0;
}
