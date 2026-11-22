// Bun has no path API.
import path from "node:path";
import { z } from "zod";
import { selectMutationUnits } from "./mutation-selection.ts";

const savedRun = z.object({
  version: z.literal(1),
  mode: z.literal("preflight").optional(),
  runId: z.string(),
  state: z.object({
    units: z.array(z.object({ name: z.string() })).min(1),
  }),
});

export async function resumeMutationSelection(root: string, runId: string) {
  if (!/^[\da-f-]{36}$/.test(runId)) return { error: "Invalid mutation resume run ID." };
  try {
    const saved = savedRun.parse(
      await Bun.file(path.join(root, ".mutation-runs", `${runId}.json`)).json(),
    );
    if (saved.mode === "preflight")
      return { error: "Preflight evidence cannot resume mutation qualification." };
    if (saved.runId !== runId) return { error: "Mutation resume run ID does not match evidence." };
    // Re-select current whole units: changed lines may have moved since the interrupted run.
    return await selectMutationUnits({ paths: saved.state.units.map((unit) => unit.name) }, root);
  } catch {
    return { error: "Mutation resume evidence is missing or incomplete." };
  }
}
