import type { DeviceConfig } from "./schema.ts";
import type { AgentHosts } from "../agent-hosts/main.ts";

type LaunchSelection = Omit<Parameters<typeof AgentHosts.resolve>[0], "cwd">;

export type SelectionRequest = {
  role?: "superAgent" | "workerAgent";
  profile?: string;
  overrides?: Partial<LaunchSelection>;
};
export type SelectionFailure = {
  reason: "profile_missing" | "selection_incomplete";
  detail: string;
};

export function selectLaunch(
  config: DeviceConfig,
  request: SelectionRequest,
):
  | SelectionFailure
  | (LaunchSelection & { role: "superAgent" | "workerAgent"; profile: string | null }) {
  const role = request.role ?? "workerAgent";
  if (request.profile !== undefined && !Object.hasOwn(config.profiles ?? {}, request.profile))
    return {
      reason: "profile_missing",
      detail: `Start profile ${request.profile} does not exist.`,
    };
  const profile = request.profile === undefined ? {} : (config.profiles?.[request.profile] ?? {});
  const selected = {
    ...config.superAgent,
    reasoningEffort:
      role === "superAgent" ? (config.superAgent.reasoningEffort ?? "high") : "medium",
  };
  if (role === "workerAgent") Object.assign(selected, config.workerAgent);
  Object.assign(selected, profile, request.overrides);
  if (selected.host === undefined || selected.model === undefined)
    return {
      reason: "selection_incomplete" as const,
      detail:
        "Set a host and model in device settings or explicit launch overrides. Operator does not choose a model for you.",
    };
  return {
    host: selected.host,
    model: selected.model,
    reasoningEffort: selected.reasoningEffort,
    role,
    profile: request.profile ?? null,
  };
}
