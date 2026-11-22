// Bun has no temporary-directory, recursive removal, or path API.
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { acquireMutationClaim, mutationStateDirectory } from "./mutation-claim.ts";
import { admitMutationSnapshot, mutationInputIdentity } from "./mutation-snapshot.ts";
import { selectMutationUnits, type MutationUnit } from "./mutation-selection.ts";
import type { MutationEvent } from "./mutation-run.ts";
import { mutationEvidence } from "./mutation-evidence.ts";
import { completeMutationEvent, mutationWorkerExitCode } from "./mutation-admission.ts";

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
  options: { json?: boolean; keepGoing?: boolean } = {},
): Promise<number> {
  const state = await mutationStateDirectory(root);
  const claim = await acquireMutationClaim(state);
  if ("error" in claim) {
    console.error(claim.error);
    return 3;
  }
  const report = path.join(state, `${claim.token}.json`);
  let interrupted = false;
  let child: Bun.Subprocess<"pipe", "inherit", "inherit"> | undefined;
  const observed: { latest?: MutationEvent } = {};
  const started = Date.now();
  function cancel() {
    interrupted = true;
    if (child?.exitCode === null) process.kill(-child.pid, "SIGKILL");
  }

  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const temporary = await mkdtemp(path.join(root, ".mutation-"));
  try {
    const snapshot = await admitMutationSnapshot(root, path.join(temporary, "snapshot"));
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
        `${JSON.stringify({ selected, root, state, token: claim.token, identity: snapshot.identity, json: options.json, keepGoing: options.keepGoing })}\n`,
      );
      await child.stdin.flush();
    }
    const workerCode = child ? await child.exited : 3;
    const code = mutationWorkerExitCode(observed.latest, workerCode);
    const current = (await mutationInputIdentity(root)) === snapshot.identity;
    if (observed.latest)
      mutationEvidence(
        root,
        options.json,
        console,
        completeMutationEvent(
          observed.latest,
          interrupted,
          current,
          snapshot.identity,
          Date.now() - started,
        ),
      );
    const status = completionStatus(interrupted, current, code);
    await Bun.write(
      report,
      JSON.stringify({ version: 1, identity: snapshot.identity, current, status, code }),
    );
    if (interrupted || !current) {
      console.error(`Mutation execution incomplete: ${status}. Historical evidence: ${report}`);
      return 3;
    }
    return code;
  } finally {
    if (child?.exitCode === null) {
      cancel();
      await child.exited;
    }
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    await rm(temporary, { recursive: true });
    await claim.release();
  }
}
