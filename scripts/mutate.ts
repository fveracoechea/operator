// Bun has no path, temporary directory, or recursive removal API.
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parseMutationArgs, selectMutationUnits, type MutationUnit } from "./mutation-selection.ts";
import { mutationGuidance } from "./mutation-policy.ts";
import { z } from "zod";

const usage = "Usage: bun run mutate <unit.ts|unit.test.ts>... | --since <ref> [paths...]";
type Counts = {
  survivors: number;
  untested: number;
  incomplete: number;
  killed: number;
  ignored: number;
};
const storedReport = z.looseObject({
  files: z.record(
    z.string(),
    z.looseObject({ mutants: z.array(z.looseObject({ status: z.string() })) }),
  ),
});
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

/**
 * The command runner reports no per-test coverage, so Stryker reuses every stored result whose code
 * is unchanged. The file name holds a hash of the mutated ranges, the beside-tests, and the runner,
 * so a changed test reruns the whole unit. Only killed and survived verdicts are kept: a timeout
 * from a busy machine, or a mutant that a new suppression now ignores, runs again.
 */
async function incrementalFile(unit: MutationUnit, inputFiles: string[]): Promise<string> {
  const inputs = await Promise.all(inputFiles.map((file) => Bun.file(file).text()));
  const hash = Bun.hash(JSON.stringify([unit.patterns, inputs])).toString(16);
  const file = path.join(process.cwd(), ".mutation-incremental", `${unit.name}.${hash}.json`);
  const stored = Bun.file(file);
  if (!(await stored.exists())) return file;
  const report = storedReport.parse(await stored.json());
  for (const result of Object.values(report.files))
    result.mutants = result.mutants.filter(
      ({ status }) => status === "Killed" || status === "Survived",
    );
  await Bun.write(file, JSON.stringify(report));
  return file;
}

async function runUnit(unit: MutationUnit, counts: Counts): Promise<void> {
  const temporary = await mkdtemp(path.join(process.cwd(), ".mutation-"));
  try {
    const configFile = path.join(temporary, "config.json");
    await Bun.write(configFile, JSON.stringify({ logLevel: "error", fileLogLevel: "off" }));
    const developmentSkills = await Array.fromAsync(
      new Bun.Glob(".agents/skills/*").scan({
        onlyFiles: false,
        dot: true,
      }),
    );
    // The checkout's own runner judges each mutant from the sandbox, so a mutant in the runner
    // never judges itself. A project without that runner uses its test script.
    const runner = path.join(process.cwd(), "scripts/test-watchdog.ts");
    const ownRunner = await Bun.file(runner).exists();
    const test = ownRunner ? [runner] : ["run", "test"];
    const { Stryker } = await import("@stryker-mutator/core");
    const mutants = await new Stryker({
      configFile,
      mutate: unit.patterns,
      testRunner: "command",
      commandRunner: {
        // The first failed test kills the mutant, so the rest of a slow suite does not run.
        command: [process.execPath, ...test, "--bail", ...unit.tests].map(quote).join(" "),
      },
      coverageAnalysis: "off",
      incremental: true,
      incrementalFile: await incrementalFile(
        unit,
        ownRunner ? [...unit.tests, runner] : unit.tests,
      ),
      // A mutant that hangs ends soon after the time of a clean run. Bail makes most mutants faster.
      timeoutFactor: 1.5,
      timeoutMS: 2000,
      concurrency: 1,
      // Stryker disable next-line ArrayDeclaration: equivalent: Stryker skips an unknown reporter name with a warning that the error log level hides
      reporters: [],
      plugins: [],
      // Instrumented files fail strict tsc, and the release build runs tsc over the sandbox.
      // The entry point keeps its declaration comments and file mode.
      disableTypeChecks: "{modules,lib,scripts,tools}/**/*.ts",
      // Bun reads the unchanged config. Stryker's rewrite requires the removed TypeScript 6 API.
      // Stryker disable next-line StringLiteral: equivalent: neither path names a file, so Stryker finds no tsconfig to rewrite
      tsconfigFile: path.join(temporary, "no-tsconfig.json"),
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
      // Stryker disable next-line ConditionalExpression, StringLiteral, BlockStatement: equivalent: coverage analysis is off, so Stryker runs every mutant and reports no NoCoverage status
      if (mutant.status === "NoCoverage") {
        // Stryker disable next-line UpdateOperator: equivalent: no NoCoverage status occurs with coverage analysis off
        counts.untested++;
        // Stryker disable next-line StringLiteral, CallExpression: equivalent: no NoCoverage status occurs with coverage analysis off
        console.log(`${location}: untested: ${mutant.mutatorName}`);
      } else if (mutant.status === "Survived") {
        counts.survivors++;
        console.log(
          `${location}: survived: ${mutant.mutatorName}: \`${originalText(unit.source, mutant.location)}\` to \`${mutant.replacement.replaceAll("\n", "\\n").replaceAll("`", "\\`")}\``,
        );
      } else if (mutant.status === "Killed") {
        counts.killed++;
      } else if (mutant.status === "Ignored") {
        counts.ignored++;
      } else {
        // A timeout, runtime error, compile error, or pending result has no verdict.
        counts.incomplete++;
        console.error(
          `${location}: incomplete: ${mutant.status}: ${mutant.statusReason ?? "no result"}`,
        );
      }
    }
  } finally {
    await rm(temporary, { recursive: true });
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
