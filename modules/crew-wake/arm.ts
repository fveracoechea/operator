import { WakeState } from "../wake-state/main.ts";
import { agents, next } from "./herdr.ts";
import { bindingTable, configDir, hasCrewAction, registerRunner, watchersOf } from "./binding.ts";

export async function arm(request: {
  root: string;
  owner: string;
  targets: string[];
  operatorBin: string;
  cliBin: string;
  pane: string;
}): Promise<string> {
  const live = await agents();
  const operator = live.find((agent) => agent.pane_id === request.pane);
  if (
    !operator ||
    operator.agent_status !== "working" ||
    !["opencode", "claude"].includes(operator.agent) ||
    !operator.agent_session?.value
  ) {
    throw new Error("The calling pane is not an identified OpenCode or Claude Code Operator");
  }

  const targets = JSON.stringify(request.targets);
  const schedule = await next({ root: request.root, operatorBin: request.operatorBin, targets });
  const ownership = schedule.ownership;
  if (
    !ownership ||
    ownership.ownerLabel !== request.owner ||
    schedule.waits.length === 0 ||
    hasCrewAction(schedule)
  ) {
    throw new Error("The Operator must own a crew with waits and no open crew action");
  }

  const values = {
    root: request.root,
    operatorBin: request.operatorBin,
    targets,
    owner: request.owner,
    acquired: ownership.acquiredAt,
    revision: ownership.revision,
    terminal: operator.terminal_id,
    session: operator.agent_session.value,
    watchers: watchersOf(schedule, live),
    state: "armed",
  };
  const dir = await configDir();
  const db = await WakeState.open(dir);
  try {
    db.insert(bindingTable)
      .values(values)
      .onConflictDoUpdate({ target: bindingTable.root, set: values })
      .run();
    await registerRunner(dir, request.root, request.cliBin);
  } finally {
    db.$client.close();
  }
  return "Operator wake armed for this crew.";
}
