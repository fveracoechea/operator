import { and, eq } from "drizzle-orm";
import { WakeState } from "../wake-state/main.ts";
import { agents, command, eventFromHerdr, herdr, next, type Event, type Agent } from "./herdr.ts";
import {
  bindingTable,
  configDir,
  hasCrewAction,
  matchesCrewEvent,
  ownedBy,
  type Binding,
} from "./binding.ts";

type Store = Awaited<ReturnType<typeof WakeState.open>>;

function idleOperator(binding: Binding, live: Agent[]): Agent | undefined {
  const agent = live.find(
    (one) => one.terminal_id === binding.terminal && one.agent_session?.value === binding.session,
  );
  return agent && ["idle", "done"].includes(agent.agent_status) ? agent : undefined;
}

async function checkOne(db: Store, binding: Binding, event: Event | null): Promise<boolean> {
  const live = await agents();
  const operator = idleOperator(binding, live);
  if (!operator) return false;

  let schedule = await next(binding);
  if (!ownedBy(binding, schedule)) {
    db.update(bindingTable)
      .set({ state: "stale" })
      .where(and(eq(bindingTable.root, binding.root), eq(bindingTable.state, "armed")))
      .run();
    return false;
  }

  const crewEvent = event !== null && (await matchesCrewEvent(event, binding, live));
  if (event && !crewEvent && operator.pane_id !== event.data.pane_id) return false;
  if (crewEvent && !hasCrewAction(schedule)) {
    // A crew report may reach Operator after Herdr has reported the status change.
    for (let attempt = 0; attempt < 4 && !hasCrewAction(schedule); attempt += 1) {
      await Bun.sleep(500);
      schedule = await next(binding);
    }
  }
  if (!ownedBy(binding, schedule) || !hasCrewAction(schedule)) return false;

  const current = idleOperator(binding, await agents());
  if (!current) return false;
  // A failed or timed-out prompt is uncertain. Another event cannot send it twice.
  const claimed = db
    .update(bindingTable)
    .set({ state: "submitted" })
    .where(and(eq(bindingTable.root, binding.root), eq(bindingTable.state, "armed")))
    .returning({ root: bindingTable.root })
    .get();
  if (!claimed) return false;
  const prompt =
    "Crew work may need attention. Run operator crew next with the current installation targets and --json. Follow its actions, waits, and user blockers. Do not infer a crew outcome from this message or from Herdr status.";
  const response = await command(herdr, ["agent", "prompt", current.pane_id, prompt]);
  if (response.exit !== 0) throw new Error(response.stderr);
  return true;
}

export async function check(request: { root: string; event: boolean }): Promise<string> {
  const event = request.event ? eventFromHerdr(process.env.HERDR_PLUGIN_EVENT_JSON) : null;
  if (request.event && !event) return "No relevant event.";
  const db = await WakeState.open(await configDir());
  try {
    const binding = db
      .select()
      .from(bindingTable)
      .where(and(eq(bindingTable.root, request.root), eq(bindingTable.state, "armed")))
      .get();
    if (!binding) return "No armed Operator.";
    return (await checkOne(db, binding, event)) ? "Woke Operator." : "No wake needed.";
  } finally {
    db.$client.close();
  }
}
