import { HerdrControl } from "../herdr-control/main.ts";

/**
 * The keys each supported host stops on.
 * Every host names its own sequence, so a host this release does not know is refused instead
 * of inheriting another host's stop.
 */
const stopKeysByHost = {
  "claude-code": ["ctrl+c", "ctrl+c", "ctrl+d"],
  opencode: ["esc", "ctrl+c", "ctrl+d"],
} as const;

export type SupportedHost = keyof typeof stopKeysByHost;

export function isSupportedHost(host: string): host is SupportedHost {
  return Object.hasOwn(stopKeysByHost, host);
}

export function stopKeysFor(host: SupportedHost): string[] {
  return [...stopKeysByHost[host]];
}

export type TerminationProof =
  | { status: "stopped" }
  | { status: "live"; paneId: string; agentStatus: string }
  | { status: "uncertain"; detail: string }
  | { status: "host-unsupported"; host: string };

/**
 * Stops one Operative through its host's own stop keys and reads back what Herdr shows.
 * Herdr is read first, so a stop whose answer was lost is reconciled from the agent that is
 * already gone instead of being sent a second time. An answer that never arrived stays
 * uncertain, because a lost answer never proves that nothing happened.
 */
export async function stopHost(request: {
  agentName: string;
  agentHost: string;
}): Promise<TerminationProof> {
  if (!isSupportedHost(request.agentHost)) {
    return { status: "host-unsupported", host: request.agentHost };
  }

  const before = await HerdrControl.findAgent({ name: request.agentName });
  if (before.status === "unknown") {
    return { status: "uncertain", detail: before.detail };
  }
  if (before.status === "absent") {
    return { status: "stopped" };
  }

  const sent = await HerdrControl.stopAgent({
    target: request.agentName,
    keys: stopKeysFor(request.agentHost),
  });
  if (sent.status === "uncertain") {
    return { status: "uncertain", detail: sent.detail };
  }
  if (
    sent.status === "failed" &&
    sent.code !== "agent_not_found" &&
    sent.code !== "pane_not_found"
  ) {
    return { status: "uncertain", detail: `${sent.code}: ${sent.detail}` };
  }

  const found = await HerdrControl.findAgent({ name: request.agentName });
  if (found.status === "unknown") {
    return { status: "uncertain", detail: found.detail };
  }

  return found.status === "absent"
    ? { status: "stopped" }
    : { status: "live", paneId: found.value.paneId, agentStatus: found.value.status };
}
