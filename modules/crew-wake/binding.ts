import { ContentIdentity } from "../content-identity/main.ts";
import { CrewState } from "../crew-state/main.ts";
import { z } from "zod";
// Bun has no atomic rename or directory creation API.
import { mkdir, rename } from "node:fs/promises";
import { callHerdr, next, type Next, type Agent, type Event } from "./herdr.ts";
import type { Binding } from "./store.ts";

const watcherSchema = z.array(
  z.object({
    attempt: z.string(),
    name: z.string(),
    terminal: z.string().nullable(),
    pane: z.string().nullable(),
  }),
);

export async function configDir(): Promise<string> {
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) return process.env.HERDR_PLUGIN_CONFIG_DIR;
  const response = await callHerdr(["plugin", "config-dir", "operator.wake"]);
  if (response.exit !== 0 || !response.stdout)
    throw new Error(response.stderr || "Operator wake plugin is not installed");
  return response.stdout;
}

type Ownership = Pick<Binding, "owner" | "acquired" | "revision">;

function ownedBy(binding: Ownership, schedule: Next): boolean {
  return (
    schedule.ownership?.ownerLabel === binding.owner &&
    schedule.ownership.acquiredAt === binding.acquired &&
    schedule.ownership.revision === binding.revision
  );
}

export function watchersOf(schedule: Next, live: Agent[]): string {
  const watchers = schedule.waits.flatMap((wait) => {
    if (!wait.attemptId || !wait.agentName) return [];
    const agent = live.find((one) => one.name === wait.agentName);
    return [
      {
        attempt: wait.attemptId,
        name: wait.agentName,
        terminal: agent?.terminal_id ?? null,
        pane: agent?.pane_id ?? null,
      },
    ];
  });
  return JSON.stringify(watchers);
}

export async function matchesCrewEvent(
  event: Event,
  binding: Binding,
  live: Agent[],
): Promise<boolean> {
  const watchers = watcherSchema.parse(JSON.parse(binding.watchers));
  if (event.data.type === "pane_exited") {
    if (watchers.some((watcher) => watcher.pane === event.data.pane_id)) return true;
    const response = await callHerdr(["pane", "get", event.data.pane_id]);
    if (response.exit !== 0) return false;
    const pane = z
      .object({ result: z.object({ pane: z.object({ terminal_id: z.string() }) }) })
      .safeParse(JSON.parse(response.stdout));
    return (
      pane.success &&
      watchers.some((watcher) => watcher.terminal === pane.data.result.pane.terminal_id)
    );
  }
  return watchers.some((watcher) =>
    live.some(
      (agent) =>
        agent.pane_id === event.data.pane_id &&
        agent.name === watcher.name &&
        (watcher.terminal === null || agent.terminal_id === watcher.terminal),
    ),
  );
}

/** A crew report can reach Operator after Herdr has reported the status change. */
export async function scheduleAfterEvent(
  binding: Binding,
  schedule: Next,
  crewEvent: boolean,
): Promise<Next> {
  let current = schedule;
  for (
    let attempt = 0;
    crewEvent && attempt < 4 && !CrewState.verdict(current).owed;
    attempt += 1
  ) {
    await Bun.sleep(500);
    current = await next(binding);
  }
  return current;
}

export async function registerRunner(dir: string, root: string, binary: string): Promise<void> {
  await mkdir(`${dir}/runners`, { recursive: true });
  const key = ContentIdentity.ofText(root);
  const path = `${dir}/runners/${key}.json`;
  const temporary = `${path}.${crypto.randomUUID()}`;
  await Bun.write(temporary, `${JSON.stringify({ root, binary })}\n`);
  await rename(temporary, path);
}

/** No row is `absent`. The other states are the recorded `bindings.state` values. */
export type WakeBindingState = "absent" | Binding["state"];

export type WakeBindingEvent =
  | { kind: "arm"; owner: string }
  | { kind: "check"; binding: Ownership }
  | { kind: "herdr-event"; binding: Ownership; pane: string }
  | { kind: "ownership-changed" };

/**
 * What the interpreter has read so far, in the order the guards ask for it.
 * `operator` and `current` are the idle Operator at the first and the last Herdr read.
 * `settled` is the schedule after the late crew report had its time to arrive.
 */
export type WakeBindingFacts = {
  caller?: Agent | undefined;
  operator?: Agent | undefined;
  schedule?: Next;
  crewEvent?: boolean;
  settled?: Next;
  current?: Agent | undefined;
};

type Fact = keyof WakeBindingFacts;

export type WakeBindingRefusal =
  | "not-armed"
  | "not-operator"
  | "no-crew-wait"
  | "operator-busy"
  | "unrelated-event"
  | "no-crew-action";

/** `arm` records the Operator session and the crew ownership it read. */
type Effect =
  | {
      kind: "arm";
      operator: Agent;
      session: string;
      schedule: Next;
      acquired: string;
      revision: number;
    }
  | { kind: "prompt"; pane: string };

export type WakeBindingDecision =
  | { next: WakeBindingState; effects: Effect[] }
  | { refused: WakeBindingRefusal }
  | { needs: Fact };

type Guard = {
  needs: Fact;
  holds: (facts: WakeBindingFacts) => boolean;
  otherwise: WakeBindingRefusal | "ownership-changed";
};

type Row = {
  from: WakeBindingState[];
  guards: Guard[];
  next: WakeBindingState;
  effects: (facts: WakeBindingFacts) => Effect[];
};

function armRow(owner: string): Row {
  return {
    from: ["absent", "armed", "submitted", "stale"],
    guards: [
      {
        needs: "caller",
        holds: ({ caller }) =>
          caller !== undefined &&
          caller.agent_status === "working" &&
          ["opencode", "claude"].includes(caller.agent) &&
          Boolean(caller.agent_session?.value),
        otherwise: "not-operator",
      },
      {
        needs: "schedule",
        holds: ({ schedule }) =>
          schedule !== undefined &&
          schedule.ownership?.ownerLabel === owner &&
          schedule.waits.length > 0 &&
          !CrewState.verdict(schedule).owed,
        otherwise: "no-crew-wait",
      },
    ],
    next: "armed",
    effects: ({ caller, schedule }) =>
      caller?.agent_session && schedule?.ownership
        ? [
            {
              kind: "arm",
              operator: caller,
              session: caller.agent_session.value,
              schedule,
              acquired: schedule.ownership.acquiredAt,
              revision: schedule.ownership.revision,
            },
          ]
        : [],
  };
}

/** A startup check has no event pane, so only a Herdr event asks whether it is relevant. */
function checkRow(binding: Ownership, pane: string | null): Row {
  const relevance: Guard[] =
    pane === null
      ? []
      : [
          {
            needs: "crewEvent",
            holds: ({ crewEvent, operator }) => crewEvent === true || operator?.pane_id === pane,
            otherwise: "unrelated-event",
          },
        ];
  return {
    from: ["armed"],
    guards: [
      {
        needs: "operator",
        holds: ({ operator }) => operator !== undefined,
        otherwise: "operator-busy",
      },
      {
        needs: "schedule",
        holds: ({ schedule }) => schedule !== undefined && ownedBy(binding, schedule),
        otherwise: "ownership-changed",
      },
      ...relevance,
      {
        needs: "settled",
        holds: ({ settled }) =>
          settled !== undefined && ownedBy(binding, settled) && CrewState.verdict(settled).owed,
        otherwise: "no-crew-action",
      },
      {
        needs: "current",
        holds: ({ current }) => current !== undefined,
        otherwise: "operator-busy",
      },
    ],
    next: "submitted",
    effects: ({ current }) =>
      current === undefined ? [] : [{ kind: "prompt", pane: current.pane_id }],
  };
}

const staleRow: Row = { from: ["armed"], guards: [], next: "stale", effects: () => [] };

/** The wake binding lifecycle: one row for each event. */
function rowFor(event: WakeBindingEvent): Row {
  switch (event.kind) {
    case "arm":
      return armRow(event.owner);
    case "check":
      return checkRow(event.binding, null);
    case "herdr-event":
      return checkRow(event.binding, event.pane);
    case "ownership-changed":
      return staleRow;
  }
}

export const WakeBinding = {
  /**
   * Pure. Gives the next state, a refusal, or the next fact the guards need. The caller reads
   * that fact, sets it (also when it reads as undefined), and asks again. So each Herdr and
   * `crew next` read happens only when a guard needs it, in the guard order. A check claims the
   * binding before its prompt, so one arm wakes the Operator once.
   */
  decide(
    state: WakeBindingState,
    event: WakeBindingEvent,
    facts: WakeBindingFacts,
  ): WakeBindingDecision {
    const row = rowFor(event);
    if (!row.from.includes(state)) return { refused: "not-armed" };
    for (const guard of row.guards) {
      if (!(guard.needs in facts)) return { needs: guard.needs };
      if (guard.holds(facts)) continue;
      return guard.otherwise === "ownership-changed"
        ? WakeBinding.decide(state, { kind: "ownership-changed" }, facts)
        : { refused: guard.otherwise };
    }
    return { next: row.next, effects: row.effects(facts) };
  },
};

type Readers = { [F in Fact]?: (facts: WakeBindingFacts) => Promise<WakeBindingFacts[F]> };

/** Runs `decide` until it has the facts it asks for. Each reader runs at most once. */
export async function decideWithReads(
  state: WakeBindingState,
  event: WakeBindingEvent,
  readers: Readers,
): Promise<Exclude<WakeBindingDecision, { needs: Fact }>> {
  const facts: WakeBindingFacts = {};
  for (;;) {
    const decision = WakeBinding.decide(state, event, facts);
    if (!("needs" in decision)) return decision;
    const read = readers[decision.needs];
    if (read === undefined) throw new Error(`No reader for the wake fact ${decision.needs}`);
    Object.assign(facts, { [decision.needs]: await read(facts) });
  }
}
