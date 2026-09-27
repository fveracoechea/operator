import { CrewState } from "../crew-state/main.ts";
import { WakeState } from "../wake-state/main.ts";
import { z } from "zod";
// Bun has no atomic rename or directory creation API.
import { mkdir, rename } from "node:fs/promises";
import { command, herdr, type Next, type Agent, type Event } from "./herdr.ts";

export const bindingTable = WakeState.table();
export type Binding = typeof bindingTable.$inferSelect;

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
  const response = await command(herdr, ["plugin", "config-dir", "operator.wake"]);
  if (response.exit !== 0 || !response.stdout)
    throw new Error(response.stderr || "Operator wake plugin is not installed");
  return response.stdout;
}

export function hasCrewAction(value: Next): boolean {
  return value.actions.some((entry) => !CrewState.isStandingAction({ action: entry.action }));
}

export function ownedBy(binding: Binding, next: Next): boolean {
  return (
    next.ownership?.ownerLabel === binding.owner &&
    next.ownership.acquiredAt === binding.acquired &&
    next.ownership.revision === binding.revision
  );
}

export function watchersOf(next: Next, live: Agent[]): string {
  const watchers = next.waits.flatMap((wait) => {
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
    const response = await command(herdr, ["pane", "get", event.data.pane_id]);
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

export async function registerRunner(dir: string, root: string, binary: string): Promise<void> {
  await mkdir(`${dir}/runners`, { recursive: true });
  const key = new Bun.CryptoHasher("sha256").update(root).digest("hex");
  const path = `${dir}/runners/${key}.json`;
  const temporary = `${path}.${crypto.randomUUID()}`;
  await Bun.write(temporary, `${JSON.stringify({ root, binary })}\n`);
  await rename(temporary, path);
}
