// Bun has no path API.
import path from "node:path";
import { z } from "zod";
import { executeMutationUnit } from "./mutate.ts";
import { runMutationUnits, type MutationEvent } from "./mutation-run.ts";
import { mutationGuidance } from "./mutation-policy.ts";
import { completeMutationEvent } from "./mutation-admission.ts";
import { mutationEvidence } from "./mutation-evidence.ts";
import { runMutationPreflight } from "./mutation-preflight.ts";
import { mutationUnitIdentity } from "./mutation-dependencies.ts";
import { mutationToolchainIdentity } from "./mutation-toolchain.ts";
import { readMutationReuse, saveMutationReuse } from "./mutation-reuse.ts";

const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let payload = "";
while (!payload.includes("\n")) {
  const chunk = await reader.read();
  if (chunk.done) {
    console.error("Mutation worker admission incomplete.");
    process.exit(3);
  }
  payload += decoder.decode(chunk.value, { stream: true });
}
const input = z
  .object({
    root: z.string(),
    state: z.string(),
    token: z.string(),
    identity: z.string(),
    json: z.boolean().optional(),
    keepGoing: z.boolean().optional(),
    preflight: z.boolean().optional(),
    selected: z.object({
      units: z.array(
        z.object({
          name: z.string(),
          source: z.string(),
          tests: z.array(z.string()),
          patterns: z.array(z.string()),
        }),
      ),
      skipped: z.number(),
    }),
  })
  .parse(JSON.parse(payload));
const started = Date.now();
const machine = input.json === true;
function noEvidenceYet() {}

let saveInterrupted = noEvidenceYet;
// EOF means that the owning command died. This detached group contains only its descendants.
void (async () => {
  try {
    while (!(await reader.read()).done) {
      /* The command keeps its ownership pipe open. */
    }
    saveInterrupted();
  } finally {
    process.kill(-process.pid, "SIGKILL");
  }
})();
const acknowledged = process.send
  ? new Promise<void>((resolve) => {
      process.once("message", () => resolve());
    })
  : undefined;
let terminal: MutationEvent | undefined;
try {
  const toolchain =
    !input.preflight && input.selected.units.some((unit) => unit.tests.length > 0)
      ? await mutationToolchainIdentity()
      : "";
  const identities = new Map<string, string | undefined>();
  if (!input.preflight)
    for (const unit of input.selected.units)
      identities.set(unit.name, await mutationUnitIdentity(process.cwd(), unit, toolchain));
  async function execute(
    unit: Parameters<typeof executeMutationUnit>[0],
    progress: Parameters<typeof executeMutationUnit>[1],
  ) {
    const identity = identities.get(unit.name);
    const damaged =
      identity &&
      (await Bun.file(path.join(input.root, ".mutation-reuse", `${identity}.json`)).exists());
    const results = await executeMutationUnit(
      unit,
      progress,
      input.root,
      machine,
      !damaged && identity ? identity : `${input.identity}.${toolchain}.${input.token}`,
      input.preflight,
    );
    await Bun.write(
      path.join(input.state, input.token, `${unit.name}.json`),
      JSON.stringify({ unit, results }),
    );
    if (input.preflight) return results;
    if ((await mutationToolchainIdentity()) !== toolchain)
      return Promise.reject(new Error("Mutation toolchain changed during execution."));
    await saveMutationReuse(input.root, identity, results);
    return results;
  }

  function event(event: MutationEvent) {
    saveInterrupted = () =>
      mutationEvidence(
        input.root,
        machine,
        console,
        completeMutationEvent(event, true, null, input.identity, Date.now() - started),
      );
    if (event.type === "run-completed") terminal = event;
    else process.send?.(event);
  }

  process.exitCode = input.preflight
    ? await runMutationPreflight(input.selected, execute, input.token, event)
    : await runMutationUnits(
        input.selected,
        execute,
        machine
          ? { log: (line) => console.error(line), error: (line) => console.error(line) }
          : console,
        {
          runId: input.token,
          keepGoing: input.keepGoing,
          reuse: (unit) => readMutationReuse(input.root, identities.get(unit.name)),
          event,
        },
      );
  if (toolchain && (await mutationToolchainIdentity()) !== toolchain) {
    process.exitCode = 3;
    if (terminal)
      terminal = completeMutationEvent(
        terminal,
        false,
        false,
        input.identity,
        Date.now() - started,
      );
  }
} catch (error) {
  console.error("Mutation execution incomplete:", error);
  (machine ? console.error : console.log)(`Mutation summary: incomplete. See ${mutationGuidance}.`);
  process.exitCode = 3;
  if (terminal)
    terminal = completeMutationEvent(terminal, false, null, input.identity, Date.now() - started);
}
if (terminal) {
  process.send?.(terminal);
  await acknowledged;
}
process.exit(process.exitCode);
