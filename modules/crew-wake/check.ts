import { agents, callHerdr, eventFromHerdr, next, type Agent, type Event } from "./herdr.ts";
import {
  configDir,
  decideWithReads,
  matchesCrewEvent,
  scheduleAfterEvent,
  type WakeBindingEvent,
} from "./binding.ts";
import { openStore, type Binding } from "./store.ts";

const prompt =
  "Crew work may need attention. Run operator crew next with the current installation targets and --json. Follow its actions, waits, and user blockers. Do not infer a crew outcome from this message or from Herdr status.";

function idleOperator(binding: Binding, live: Agent[]): Agent | undefined {
  const agent = live.find(
    (one) => one.terminal_id === binding.terminal && one.agent_session?.value === binding.session,
  );
  return agent && ["idle", "done"].includes(agent.agent_status) ? agent : undefined;
}

async function checkOne(
  store: Awaited<ReturnType<typeof openStore>>,
  binding: Binding,
  event: Event | null,
): Promise<boolean> {
  let live: Agent[] = [];
  const wakeEvent: WakeBindingEvent =
    event === null
      ? { kind: "check", binding }
      : { kind: "herdr-event", binding, pane: event.data.pane_id };
  const decision = await decideWithReads(binding.state, wakeEvent, {
    operator: async () => {
      live = await agents();
      return idleOperator(binding, live);
    },
    schedule: async () => next(binding),
    crewEvent: async () => event !== null && (await matchesCrewEvent(event, binding, live)),
    settled: async (facts) =>
      facts.schedule && scheduleAfterEvent(binding, facts.schedule, facts.crewEvent === true),
    current: async () => idleOperator(binding, await agents()),
  });
  if ("refused" in decision) return false;
  if (decision.next === "stale") {
    store.markStale(binding.root);
    return false;
  }

  // A failed or timed-out prompt is uncertain. Another event cannot send it twice.
  if (!store.claim(binding.root)) return false;
  for (const effect of decision.effects) {
    if (effect.kind !== "prompt") continue;
    const response = await callHerdr(["agent", "prompt", effect.pane, prompt]);
    if (response.exit !== 0) throw new Error(response.stderr);
  }
  return true;
}

export async function check(request: { root: string; event: boolean }): Promise<string> {
  const event = request.event ? eventFromHerdr(process.env.HERDR_PLUGIN_EVENT_JSON) : null;
  if (request.event && !event) return "No relevant event.";
  const store = await openStore(await configDir());
  try {
    const binding = store.armed(request.root);
    if (!binding) return "No armed Operator.";
    return (await checkOne(store, binding, event)) ? "Woke Operator." : "No wake needed.";
  } finally {
    store.close();
  }
}
