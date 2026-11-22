// Bun has no temporary-directory, recursive removal, or path API.
import { mkdtemp, rm } from "node:fs/promises";
// Final evidence must be persisted without yielding past the budget decision.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { acquireMutationClaim, mutationStateDirectory } from "./mutation-claim.ts";
import { admitMutationSnapshot, mutationInputIdentity } from "./mutation-snapshot.ts";
import { selectMutationUnits, type MutationUnit } from "./mutation-selection.ts";
import type { MutationEvent } from "./mutation-run.ts";
import { mutationEvidence } from "./mutation-evidence.ts";
import { completeMutationEvent, mutationWorkerExitCode } from "./mutation-admission.ts";
import { mutationBudget } from "./mutation-budget.ts";

function finishCampaign(
  root: string,
  report: string,
  identity: string,
  event: MutationEvent,
  code: number,
  outcome: {
    interrupted: boolean;
    current: boolean | null;
    exhausted: boolean;
    elapsedMs: number;
    json?: boolean;
  },
): number {
  const { interrupted, current, exhausted, elapsedMs } = outcome;
  mutationEvidence(
    root,
    outcome.json,
    console,
    completeMutationEvent(
      event,
      interrupted,
      current,
      identity,
      elapsedMs,
      exhausted ? "budget-exhausted" : undefined,
    ),
  );
  const status = exhausted
    ? "budget-exhausted"
    : completionStatus(interrupted, current === true, code);
  const incomplete = exhausted || interrupted || !current;
  writeFileSync(
    report,
    JSON.stringify({ version: 1, identity, current, status, code: incomplete ? 3 : code }),
  );
  if (incomplete)
    console.error(`Mutation execution incomplete: ${status}. Historical evidence: ${report}`);
  return incomplete ? 3 : code;
}

function unrunEvent(
  token: string,
  selected: { units: MutationUnit[]; skipped: number },
): MutationEvent {
  return {
    version: 1,
    runId: token,
    sequence: 0,
    type: "run-started",
    elapsedMs: 0,
    state: {
      status: "running",
      activeUnit: null,
      completedUnits: 0,
      skipped: selected.skipped,
      units: selected.units.map((unit) => ({
        name: unit.name,
        tests: unit.tests,
        patterns: unit.patterns,
        status: "unrun",
        mutants: null,
        progress: { completed: 0, total: null, reused: 0 },
      })),
    },
  };
}

function completionStatus(interrupted: boolean, current: boolean, code: number): string {
  if (interrupted) return "cancelled";
  if (!current) return "inputs-changed";
  return code === 0 ? "qualified" : "failed";
}

async function selectedSourcesMatch(directory: string, units: MutationUnit[]): Promise<boolean> {
  const prepared = await selectMutationUnits({ paths: units.map((unit) => unit.name) }, directory);
  if ("error" in prepared) return false;
  function inputs(unit: MutationUnit) {
    return { name: unit.name, source: unit.source, tests: unit.tests };
  }

  return JSON.stringify(prepared.units.map(inputs)) === JSON.stringify(units.map(inputs));
}

export async function runMutationCampaign(
  root: string,
  selected: { units: MutationUnit[]; skipped: number },
  selectionIdentity: string,
  options: {
    json?: boolean;
    keepGoing?: boolean;
    preflight?: boolean;
    budget?: ReturnType<typeof mutationBudget>;
  } = {},
): Promise<number> {
  const state = await mutationStateDirectory(root);
  const claim = await acquireMutationClaim(state);
  if ("error" in claim) {
    console.error(claim.error);
    return 3;
  }
  const report = path.join(state, `${claim.token}.json`);
  const budget = options.budget ?? mutationBudget();
  let interrupted = false;
  let child: Bun.Subprocess<"pipe", "inherit", "inherit"> | undefined;
  const observed: { latest: MutationEvent } = { latest: unrunEvent(claim.token, selected) };
  const started = Date.now();
  function cancel() {
    interrupted = true;
    if (child?.exitCode === null) process.kill(-child.pid, "SIGKILL");
  }

  async function stopWorker() {
    if (child?.exitCode === null) {
      cancel();
      await child.exited;
    }
  }

  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  budget.signal.addEventListener("abort", cancel);
  const temporary = await mkdtemp(path.join(root, ".mutation-"));
  try {
    budget.check();
    const snapshot = await admitMutationSnapshot(
      root,
      path.join(temporary, "snapshot"),
      budget.signal,
    );
    if (
      snapshot.identity !== selectionIdentity ||
      !(await selectedSourcesMatch(snapshot.directory, selected.units))
    ) {
      console.error("Mutation inputs changed during selection.");
      return 3;
    }
    await Bun.write(
      report,
      JSON.stringify({ version: 1, identity: snapshot.identity, status: "running" }),
    );
    budget.check();
    if (!interrupted) {
      const tools =
        path.dirname(import.meta.dir) === root
          ? path.join(snapshot.directory, path.basename(import.meta.dir))
          : import.meta.dir;
      child = Bun.spawn([process.execPath, path.join(tools, "mutation-worker.ts")], {
        cwd: snapshot.directory,
        detached: true,
        stdin: "pipe",
        stdout: "inherit",
        stderr: "inherit",
        ipc(event: MutationEvent, worker) {
          observed.latest = event;
          if (event.type === "run-completed") worker.send({});
          else
            mutationEvidence(root, options.json, console, {
              ...event,
              admission: { identity: snapshot.identity, current: null },
            });
        },
      });
      await claim.setGroup(child.pid);
      await child.stdin.write(
        `${JSON.stringify({ selected, root, state, token: claim.token, identity: snapshot.identity, json: options.json, keepGoing: options.keepGoing, preflight: options.preflight })}\n`,
      );
      await child.stdin.flush();
    }
    const workerCode = child ? await child.exited : 3;
    const code = mutationWorkerExitCode(observed.latest, workerCode);
    const current = budget.signal.aborted
      ? null
      : (await mutationInputIdentity(root, budget.signal)) === snapshot.identity;
    return finishCampaign(root, report, snapshot.identity, observed.latest, code, {
      interrupted,
      current,
      exhausted: budget.signal.aborted,
      elapsedMs: Date.now() - started,
      json: options.json,
    });
  } catch (error) {
    if (!budget.signal.aborted) return await Promise.reject(error);
    return finishCampaign(root, report, selectionIdentity, observed.latest, 3, {
      interrupted: true,
      current: null,
      exhausted: true,
      elapsedMs: Date.now() - started,
      json: options.json,
    });
  } finally {
    await stopWorker();
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    budget.signal.removeEventListener("abort", cancel);
    await rm(temporary, { recursive: true });
    await claim.release();
  }
}
