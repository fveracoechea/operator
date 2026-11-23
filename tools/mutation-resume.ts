// Bun has no path API.
import path from "node:path";
import { z } from "zod";
import { selectMutationUnits } from "./mutation-selection.ts";
import { mutationReuseSchema } from "./mutation-reuse.ts";

const savedRun = z.object({
  version: z.literal(1),
  mode: z.literal("preflight").optional(),
  runId: z.string(),
  state: z.object({
    units: z.array(z.object({ name: z.string(), reuse: mutationReuseSchema.optional() })).min(1),
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
    const selected = await selectMutationUnits(
      { paths: saved.state.units.map((unit) => unit.name) },
      root,
    );
    if ("error" in selected) return selected;
    const previous = new Map(saved.state.units.map((unit) => [unit.name, unit.reuse]));
    for (const unit of selected.units) {
      const reuse = previous.get(unit.name);
      if (reuse?.eligible) unit.previousIdentity = reuse.identity;
    }
    return selected;
  } catch {
    return { error: "Mutation resume evidence is missing or incomplete." };
  }
}
