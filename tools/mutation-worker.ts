// Bun has no path API.
import path from "node:path";
import { z } from "zod";
import { executeMutationUnit } from "./mutate.ts";
import { runMutationUnits } from "./mutation-run.ts";
import { mutationGuidance } from "./mutation-policy.ts";
import { completeMutationEvent } from "./mutation-admission.ts";
import { mutationEvidence } from "./mutation-evidence.ts";

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
try {
  process.exitCode = await runMutationUnits(
    input.selected,
    async (unit, progress) => {
      const results = await executeMutationUnit(
        unit,
        progress,
        input.root,
        machine,
        input.identity,
      );
      await Bun.write(
        path.join(input.state, input.token, `${unit.name}.json`),
        JSON.stringify({ unit, results }),
      );
      return results;
    },
    machine
      ? { log: (line) => console.error(line), error: (line) => console.error(line) }
      : console,
    {
      runId: input.token,
      keepGoing: input.keepGoing,
      event: (event) => {
        saveInterrupted = () =>
          mutationEvidence(
            input.root,
            machine,
            console,
            completeMutationEvent(event, true, null, input.identity, Date.now() - started),
          );
        process.send?.(event);
      },
    },
  );
} catch (error) {
  console.error("Mutation execution incomplete:", error);
  (machine ? console.error : console.log)(`Mutation summary: incomplete. See ${mutationGuidance}.`);
  process.exitCode = 3;
}
await acknowledged;
process.exit(process.exitCode);
