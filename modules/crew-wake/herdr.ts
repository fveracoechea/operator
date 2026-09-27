import { z } from "zod";

const agentSchema = z.object({
  pane_id: z.string(),
  terminal_id: z.string(),
  agent: z.string(),
  name: z.string().nullish(),
  agent_status: z.string(),
  agent_session: z.object({ kind: z.string(), value: z.string() }).nullish(),
});
export type Agent = z.infer<typeof agentSchema>;

const nextSchema = z.object({
  ownership: z
    .object({ ownerLabel: z.string(), acquiredAt: z.string(), revision: z.number() })
    .nullable(),
  actions: z.array(z.object({ action: z.string(), blocker: z.string().nullable() })),
  waits: z.array(z.object({ agentName: z.string().nullable(), attemptId: z.string().nullable() })),
});
export type Next = z.infer<typeof nextSchema>;

const eventSchema = z.object({
  event: z.string(),
  data: z.object({ type: z.string(), pane_id: z.string(), agent_status: z.string().optional() }),
});
export type Event = z.infer<typeof eventSchema>;

export const herdr = process.env.HERDR_BIN_PATH ?? "herdr";

export async function command(binary: string, args: string[], cwd?: string) {
  const child = Bun.spawn([binary, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exit };
}

export async function agents(): Promise<Agent[]> {
  const response = await command(herdr, ["agent", "list"]);
  if (response.exit !== 0) throw new Error(response.stderr);
  return z
    .object({ result: z.object({ agents: z.array(agentSchema) }) })
    .parse(JSON.parse(response.stdout)).result.agents;
}

/** A wake reads the CLI schedule. It never derives an outcome from a Herdr status. */
export async function next(request: {
  operatorBin: string;
  targets: string;
  root: string;
}): Promise<Next> {
  const targets = z.array(z.string()).parse(JSON.parse(request.targets));
  const response = await command(
    "bun",
    [request.operatorBin, "crew", "next", ...targets, "--json"],
    request.root,
  );
  if (![0, 3, 6].includes(response.exit)) throw new Error(response.stderr || response.stdout);
  return z.object({ data: nextSchema }).parse(JSON.parse(response.stdout)).data;
}

export function eventFromHerdr(raw: string | undefined): Event | null {
  if (!raw) return null;
  const event = eventSchema.parse(JSON.parse(raw));
  if (
    event.data.type === "pane_exited" ||
    (event.data.type === "pane_agent_status_changed" &&
      ["idle", "done", "blocked"].includes(event.data.agent_status ?? ""))
  )
    return event;
  return null;
}
