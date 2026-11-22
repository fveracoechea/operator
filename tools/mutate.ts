// Bun has no path, temporary directory, or recursive removal API.
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parseMutationArgs, selectMutationUnits, type MutationUnit } from "./mutation-selection.ts";
import { mutationGuidance } from "./mutation-policy.ts";
import { runMutationUnits, type MutationResult } from "./mutation-run.ts";
import { z } from "zod";

const usage = "Usage: bun run mutate <unit.ts|unit.test.ts>... | --since <ref> [paths...]";
const storedReport = z.looseObject({
  files: z.record(
    z.string(),
    z.looseObject({ mutants: z.array(z.looseObject({ status: z.string() })) }),
  ),
});

function quote(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
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

async function executeMutationUnit(unit: MutationUnit): Promise<MutationResult[]> {
  const temporary = await mkdtemp(path.join(process.cwd(), ".mutation-"));
  try {
    const configFile = path.join(temporary, "config.json");
    await Bun.write(configFile, JSON.stringify({ logLevel: "error", fileLogLevel: "off" }));
    // The checkout's own runner judges each mutant from the sandbox, so a mutant in the runner
    // never judges itself. A project without that runner uses its test script.
    const runner = path.join(process.cwd(), "tools/test-watchdog.ts");
    const ownRunner = await Bun.file(runner).exists();
    const test = ownRunner ? [runner] : ["run", "test"];
    const { Stryker } = await import("@stryker-mutator/core");
    return await new Stryker({
      configFile,
      mutate: unit.patterns,
      testRunner: "command",
      commandRunner: {
        // The first failed test kills the mutant, so the rest of a slow suite does not run.
        // Stryker writes sandbox files with mode 0600, including the source command.
        // Restore that sandbox entry, so readiness tests still verify the real executable identity.
        command: `${quote(process.execPath)} -e ${quote('import { chmodSync, lstatSync, realpathSync } from "node:fs"; import { resolve } from "node:path"; const entry = "src/cli.ts"; const file = lstatSync(entry, { throwIfNoEntry: false }); if (file?.isFile() && realpathSync(entry) === resolve(entry)) chmodSync(entry, 0o755);')} && ${[process.execPath, ...test, "--bail", ...unit.tests].map(quote).join(" ")}`,
      },
      coverageAnalysis: "off",
      incremental: true,
      incrementalFile: await incrementalFile(
        unit,
        ownRunner ? [...unit.tests, runner] : unit.tests,
      ),
      // The full CLI baseline exceeds Stryker's five-minute default.
      dryRunTimeoutMinutes: 30,
      timeoutFactor: 1.5,
      timeoutMS: 2000,
      concurrency: 1,
      // Stryker disable next-line ArrayDeclaration: equivalent: Stryker skips an unknown reporter name with a warning that the error log level hides
      reporters: [],
      plugins: [],
      // Instrumented files fail strict tsc, and the release build runs tsc over the sandbox.
      // The entry point keeps its declaration comments and file mode.
      disableTypeChecks: "{src,tools}/**/*.ts",
      // Bun reads the unchanged config. Stryker's rewrite requires the removed TypeScript 6 API.
      // Stryker disable next-line StringLiteral: equivalent: neither path names a file, so Stryker finds no tsconfig to rewrite
      tsconfigFile: path.join(temporary, "no-tsconfig.json"),
      tempDirName: path.join(temporary, "sandbox"),
      cleanTempDir: "always",
      // Never copy legacy state or host skill links into a sandbox.
      ignorePatterns: [".operator", ".mutation-*", ".claude", ".agents"],
    }).runMutationTest();
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
  return runMutationUnits(selected, executeMutationUnit, console);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error("Mutation execution incomplete:", error);
  console.log(`Mutation summary: incomplete. See ${mutationGuidance}.`);
  process.exitCode = 3;
}
