import { agents, next, type Agent } from "./herdr.ts";
import { configDir, decideWithReads, registerRunner, watchersOf } from "./binding.ts";
import { openStore } from "./store.ts";

export async function arm(request: {
  root: string;
  owner: string;
  targets: string[];
  operatorBin: string;
  cliBin: string;
  pane: string;
}): Promise<string> {
  const targets = JSON.stringify(request.targets);
  let live: Agent[] = [];
  // An arm replaces any earlier binding of the root, so the recorded state does not matter.
  const decision = await decideWithReads(
    "absent",
    { kind: "arm", owner: request.owner },
    {
      caller: async () => {
        live = await agents();
        return live.find((agent) => agent.pane_id === request.pane);
      },
      schedule: async () => next({ root: request.root, operatorBin: request.operatorBin, targets }),
    },
  );
  if ("refused" in decision) {
    throw new Error(
      decision.refused === "not-operator"
        ? "The calling pane is not an identified OpenCode or Claude Code Operator"
        : "The Operator must own a crew with waits and no open crew action",
    );
  }

  const dir = await configDir();
  const store = await openStore(dir);
  try {
    for (const effect of decision.effects) {
      if (effect.kind !== "arm") continue;
      store.save({
        root: request.root,
        operatorBin: request.operatorBin,
        targets,
        owner: request.owner,
        acquired: effect.acquired,
        revision: effect.revision,
        terminal: effect.operator.terminal_id,
        session: effect.session,
        watchers: watchersOf(effect.schedule, live),
        state: "armed",
      });
      await registerRunner(dir, request.root, request.cliBin);
    }
  } finally {
    store.close();
  }
  return "Operator wake armed for this crew.";
}
