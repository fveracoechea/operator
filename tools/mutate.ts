// Bun has no path, temporary directory, or recursive removal API.
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parseMutationArgs, selectMutationUnits, type MutationUnit } from "./mutation-selection.ts";
import { mutationGuidance } from "./mutation-policy.ts";
import type { MutationResult } from "./mutation-run.ts";
import { runMutationCampaign } from "./mutation-campaign.ts";
import { mutationStateDirectory, recoverMutationClaim } from "./mutation-claim.ts";
import { mutationInputIdentity } from "./mutation-snapshot.ts";
import { z } from "zod";
import { reportMutationProgress, type MutationProgress } from "./mutation-engine-progress.ts";
import { printMutationPlan } from "./mutation-plan.ts";
import { mutationBudget } from "./mutation-budget.ts";
import { resumeMutationSelection } from "./mutation-resume.ts";
import { mutationRefusal } from "./mutation-evidence.ts";

const usage =
  "Usage: bun run mutate <unit.ts|unit.test.ts>... | --since <ref> [paths...] [--plan [--proof <file>]|--preflight] [--budget <seconds>] [--keep-going] [--json] | --resume <run-id> | --recover-claim";
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
 * The command runner has no per-test coverage, so Stryker reuses unchanged stored verdicts.
 * The worker supplies a validated dependency identity, or a fresh identity for uncertain inputs.
 * Only killed and survived per-mutant verdicts remain eligible after an incomplete run.
 */
async function incrementalFile(
  unit: MutationUnit,
  inputFiles: string[],
  root: string,
  identity: string,
): Promise<string> {
  const inputs = await Promise.all(inputFiles.map((file) => Bun.file(file).text()));
  const hash = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([identity, unit.patterns, inputs]))
    .digest("hex");
  const file = path.join(root, ".mutation-incremental", `${unit.name}.${hash}.json`);
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

export async function executeMutationUnit(
  unit: MutationUnit,
  progress: (progress: MutationProgress) => void,
  root: string,
  machine: boolean,
  identity: string,
  preflight = false,
): Promise<MutationResult[]> {
  const temporary = await mkdtemp(path.join(process.cwd(), ".mutation-"));
  try {
    const configFile = path.join(temporary, "config.json");
    await Bun.write(
      configFile,
      JSON.stringify({ logLevel: machine ? "off" : "error", fileLogLevel: "off" }),
    );
    // The checkout's own runner judges each mutant from the sandbox, so a mutant in the runner
    // never judges itself. A project without that runner uses its test script.
    const runner = path.join(process.cwd(), "tools/test-watchdog.ts");
    const ownRunner = await Bun.file(runner).exists();
    const test = ownRunner ? [runner] : ["run", "test"];
    const { Stryker } = await import("@stryker-mutator/core");
    const engine = new Stryker({
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
      dryRunOnly: preflight,
      incremental: !preflight,
      incrementalFile: preflight
        ? path.join(temporary, "unused.json")
        : await incrementalFile(
            unit,
            ownRunner ? [...unit.tests, runner] : unit.tests,
            root,
            identity,
          ),
      // The full CLI baseline exceeds Stryker's five-minute default.
      dryRunTimeoutMinutes: 30,
      timeoutFactor: 1.5,
      timeoutMS: 2000,
      concurrency: 1,
      reporters: ["operator-progress"],
      plugins: [path.join(import.meta.dir, "mutation-engine-progress.ts")],
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
    });
    return await reportMutationProgress(progress, () => engine.runMutationTest());
  } finally {
    await rm(temporary, { recursive: true });
  }
}

let machine = false;

async function main(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === "--recover-claim") {
    const result = await recoverMutationClaim(await mutationStateDirectory(process.cwd()));
    if ("error" in result) {
      console.error(result.error);
      return 3;
    }
    console.log("Recovered interrupted mutation claim. Historical evidence was preserved.");
    return 0;
  }
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return 0;
  }
  const parsed = parseMutationArgs(args);
  if ("error" in parsed) {
    console.error(`${parsed.error}\n${usage}`);
    return 1;
  }
  machine = parsed.json === true;
  const budget = mutationBudget(parsed.budgetMs);
  let delegated = false;
  try {
    const selectionIdentity = parsed.plan
      ? undefined
      : await mutationInputIdentity(process.cwd(), budget.signal);
    budget.check();
    const selected = parsed.resume
      ? await resumeMutationSelection(process.cwd(), parsed.resume)
      : await selectMutationUnits(parsed, process.cwd());
    if ("error" in selected) {
      console.error(selected.error);
      return 1;
    }
    budget.check();
    if (selectionIdentity === undefined) {
      return await printMutationPlan(selected, machine, parsed.proof);
    }
    await printMutationPlan(selected, false);
    budget.check();
    delegated = true;
    return await runMutationCampaign(process.cwd(), selected, selectionIdentity, {
      ...parsed,
      budget,
    });
  } catch (error) {
    if (!delegated && budget.signal.aborted) mutationRefusal(machine, console, "budget-exhausted");
    return await Promise.reject(error);
  } finally {
    budget.dispose();
  }
}

if (import.meta.main)
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error("Mutation execution incomplete:", error);
    (machine ? console.error : console.log)(
      `Mutation summary: incomplete. See ${mutationGuidance}.`,
    );
    process.exitCode = 3;
  }
