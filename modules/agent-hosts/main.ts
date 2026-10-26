import { Err, Ok, fromPromise, type Result } from "unthrown";
import { z } from "zod";
import { discoverClaude, discoverOpenCode, type Host, type HostFailure } from "./catalog.ts";

type LaunchSelection = { host: Host; model: string; reasoningEffort: string };
type ResolvedLaunch = LaunchSelection & {
  requestedModel: string;
  command: { tool: string; args: string[] };
};

function qualify<T>(cause: unknown, defect: (cause: unknown) => T) {
  if (
    cause instanceof SyntaxError ||
    cause instanceof z.ZodError ||
    (cause instanceof Error &&
      "code" in cause &&
      ["ENOENT", "EACCES", "EPERM", "EIO", "ENOTDIR"].includes(String(cause.code)))
  )
    return {
      reason: "host_metadata_failed" as const,
      detail:
        "The host did not return valid model and effort metadata. No selection was substituted.",
    };
  return defect(cause);
}

/** Host metadata is not a readiness proof. Commands contain no permission policy or fallback. */
export const AgentHosts = {
  models(input: { host: Host; cwd: string }) {
    return fromPromise(
      () => (input.host === "opencode" ? discoverOpenCode(input.cwd) : discoverClaude(input.cwd)),
      qualify,
    ).flatMap((models) => ("reason" in models ? Err(models) : Ok(models)));
  },
  resolve(input: LaunchSelection & { cwd: string }) {
    return AgentHosts.models(input).flatMap((models): Result<ResolvedLaunch, HostFailure> => {
      const model = models.find(
        (candidate) => candidate.model === input.model || candidate.resolvedModel === input.model,
      );
      if (model === undefined)
        return Err({
          reason: "unsupported_model" as const,
          detail: `${input.host} does not advertise model ${input.model}. Select a model from operator host models.`,
        });
      if (!model.efforts.includes(input.reasoningEffort))
        return Err({
          reason: "unsupported_effort" as const,
          detail: `${input.host} model ${input.model} does not advertise effort ${input.reasoningEffort}. Supported efforts: ${model.efforts.join(", ") || "none advertised"}.`,
        });
      const resolvedModel = model.resolvedModel ?? model.model;
      return Ok({
        host: input.host,
        model: resolvedModel,
        requestedModel: input.model,
        reasoningEffort: input.reasoningEffort,
        command:
          input.host === "opencode"
            ? {
                tool: "opencode",
                args: ["mini", "--model", `${resolvedModel}#${input.reasoningEffort}`],
              }
            : {
                tool: "claude",
                args: ["--model", resolvedModel, "--effort", input.reasoningEffort],
              },
      });
    });
  },
};
