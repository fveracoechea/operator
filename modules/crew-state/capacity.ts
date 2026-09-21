import { OperatorConfig } from "../operator-config/main.ts";

export const DEFAULT_ACTIVE_AGENTS = 3;
export const CONFIG_PATH = ".operator/config.json";

export type Capacity = {
  limit: number;
  limitSource: "project-configuration" | "operator-default";
  reviewReserve: number;
  productionLimit: number;
};

export type CapacityRead =
  | { status: "ok"; capacity: Capacity }
  | { status: "invalid-configuration"; issues: string[] };

/**
 * Review keeps the last slot, so a full production queue can never starve a queued review.
 * A one-agent crew reserves nothing and therefore runs one assignment at a time.
 */
export function capacityFor(limit: number, source: Capacity["limitSource"]): Capacity {
  const reviewReserve = limit >= 2 ? 1 : 0;
  return { limit, limitSource: source, reviewReserve, productionLimit: limit - reviewReserve };
}

/** Reads the crew concurrency this project selected. Unreadable configuration is refused. */
export async function readCapacity(projectRoot: string): Promise<CapacityRead> {
  const file = Bun.file(`${projectRoot}/${CONFIG_PATH}`);
  if (!(await file.exists())) {
    return { status: "ok", capacity: capacityFor(DEFAULT_ACTIVE_AGENTS, "operator-default") };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    return { status: "invalid-configuration", issues: [String(error)] };
  }

  const result = OperatorConfig.parse(parsed);
  if (!result.ok) {
    return { status: "invalid-configuration", issues: result.issues };
  }

  const limit = result.config.crew?.maxActiveAgents;
  return {
    status: "ok",
    capacity:
      limit === undefined
        ? capacityFor(DEFAULT_ACTIVE_AGENTS, "operator-default")
        : capacityFor(limit, "project-configuration"),
  };
}
