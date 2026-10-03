import { z } from "zod";
import { ToolInvocation } from "../tool-invocation/main.ts";

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

const herdr = process.env.HERDR_BIN_PATH ?? "herdr";

/**
 * Every call is bounded, so a hung Herdr or `crew next` cannot hold a plugin run open.
 * A call with no answer throws, because a prompt that timed out may still have landed.
 */
const HERDR_TIMEOUT_MS = 30_000;
const NEXT_TIMEOUT_MS = 120_000;

async function command(request: { tool: string; args: string[]; cwd?: string; timeoutMs: number }) {
  const invoked = await ToolInvocation.run(request);
  if (invoked.status !== "completed") throw new Error(invoked.detail);
  return { stdout: invoked.stdout.trim(), stderr: invoked.stderr.trim(), exit: invoked.exitCode };
}

export async function callHerdr(args: string[]) {
  return command({ tool: herdr, args, timeoutMs: HERDR_TIMEOUT_MS });
}

export async function agents(): Promise<Agent[]> {
  const response = await callHerdr(["agent", "list"]);
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
  const response = await command({
    tool: "bun",
    args: [request.operatorBin, "crew", "next", ...targets, "--json"],
    cwd: request.root,
    timeoutMs: NEXT_TIMEOUT_MS,
  });
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
