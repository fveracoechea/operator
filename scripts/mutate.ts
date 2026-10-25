// Bun has no path, temporary directory, or recursive removal API.
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parseMutationArgs, selectMutationUnits, type MutationUnit } from "./mutation-selection.ts";
import { mutationGuidance } from "./mutation-policy.ts";

const usage = "Usage: bun run mutate <unit.ts|unit.test.ts>... | --since <ref> [paths...]";
type Counts = {
  survivors: number;
  untested: number;
  incomplete: number;
  killed: number;
  ignored: number;
};
type Location = { start: { line: number; column: number }; end: { line: number; column: number } };

function quote(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
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

async function runUnit(unit: MutationUnit, counts: Counts): Promise<void> {
  const temporary = await mkdtemp(path.join(process.cwd(), ".mutation-"));
  try {
    const configFile = path.join(temporary, "config.json");
    await Bun.write(configFile, JSON.stringify({ logLevel: "error", fileLogLevel: "off" }));
    const developmentSkills = await Array.fromAsync(
      new Bun.Glob(".agents/skills/*").scan({
        onlyFiles: false,
        followSymlinks: false,
        dot: true,
      }),
    );
    const { Stryker } = await import("@stryker-mutator/core");
    const mutants = await new Stryker({
      configFile,
      mutate: unit.patterns,
      testRunner: "command",
      commandRunner: {
        command: [process.execPath, "run", "test", ...unit.tests].map(quote).join(" "),
      },
      coverageAnalysis: "off",
      incremental: false,
      concurrency: 1,
      reporters: [],
      plugins: [],
      disableTypeChecks: false,
      // Bun reads the unchanged config. Stryker's rewrite requires the removed TypeScript 6 API.
      tsconfigFile: path.join(temporary, "no-tsconfig.json"),
      thresholds: { high: 100, low: 100, break: null },
      tempDirName: path.join(temporary, "sandbox"),
      cleanTempDir: "always",
      // Never copy legacy state or host skill links into a sandbox.
      ignorePatterns: [
        ".operator",
        ".mutation-*",
        ".claude",
        ...developmentSkills.filter((name) => name !== ".agents/skills/unit-testing"),
      ],
    }).runMutationTest();
    for (const mutant of mutants) {
      const location = `${unit.name}:${mutant.location.start.line}`;
      switch (mutant.status) {
        case "Survived": {
          counts.survivors++;
          console.log(
            `${location}: survived: ${mutant.mutatorName}: \`${originalText(unit.source, mutant.location)}\` to \`${mutant.replacement.replaceAll("\n", "\\n").replaceAll("`", "\\`")}\``,
          );
          break;
        }
        case "NoCoverage": {
          counts.untested++;
          console.log(`${location}: untested: ${mutant.mutatorName}`);
          break;
        }
        case "Killed": {
          counts.killed++;
          break;
        }
        case "Ignored": {
          counts.ignored++;
          break;
        }
        case "CompileError":
        case "Pending":
        case "RuntimeError":
        case "Timeout": {
          counts.incomplete++;
          console.error(
            `${location}: incomplete: ${mutant.status}: ${mutant.statusReason ?? "no result"}`,
          );
        }
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return 0;
  }
  const parsed = parseMutationArgs(args);
  if ("error" in parsed) {
    console.error(`${parsed.error}\n${usage}`);
    return 1;
  }
  const selected = await selectMutationUnits(parsed, process.cwd());
  if ("error" in selected) {
    console.error(selected.error);
    return 1;
  }
  const counts: Counts = { survivors: 0, untested: 0, incomplete: 0, killed: 0, ignored: 0 };
  for (const unit of selected.units) {
    if (unit.tests.length === 0) {
      console.log(`${unit.name}: untested. Add a direct beside-test.`);
      counts.untested++;
    } else {
      await runUnit(unit, counts);
    }
  }
  console.log(
    `Mutation summary: ${counts.survivors} survivors, ${counts.untested} untested, ${counts.incomplete} incomplete, ${counts.killed} killed, ${counts.ignored} ignored, ${selected.skipped} skipped. See ${mutationGuidance}.`,
  );
  if (counts.incomplete > 0) return 3;
  return counts.survivors + counts.untested > 0 ? 2 : 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error("Mutation execution incomplete:", error);
  console.log(`Mutation summary: incomplete. See ${mutationGuidance}.`);
  process.exitCode = 3;
}
