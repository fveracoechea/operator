import { isCodedError } from "../../lib/coded-error.ts";
import type { ResultContext } from "../../lib/cli-result.ts";
import { Err, Ok, OkAsync, fromPromise, type Result } from "unthrown";
import { z } from "zod";
import { discoverClaude, discoverOpenCode, type Host, type HostFailure } from "./catalog.ts";
import { Herdr } from "../herdr/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";

type LaunchSelection = { host: Host; model: string; reasoningEffort: string };
type ResolvedLaunch = LaunchSelection & {
  requestedModel: string;
  command: { tool: string; args: string[] };
};

const createdSession = z.object({
  data: z.object({
    id: z.string().min(1),
    agent: z.literal("worker"),
    model: z.object({ providerID: z.string(), id: z.string(), variant: z.string() }),
    location: z.object({ directory: z.string() }),
  }),
});
const sessionFailure = {
  reason: "host_session_failed" as const,
  next: {
    decider: "super-agent" as const,
    question:
      "How should the possibly-created OpenCode session be inspected before another launch attempt?",
  },
  detail:
    "OpenCode did not confirm a session with the worker agent and selected model, effort, and directory. No agent was started. Session creation may have succeeded; inspect OpenCode before retrying.",
};

function openCodeArguments(launch: LaunchSelection, cwd: string) {
  // The catalog qualifies models as provider/id; model ids can themselves contain slashes.
  const separator = launch.model.indexOf("/");
  const model = {
    providerID: launch.model.slice(0, separator),
    id: launch.model.slice(separator + 1),
    variant: launch.reasoningEffort,
  };
  return fromPromise(
    async () => {
      const result = await ToolInvocation.run({
        tool: "opencode",
        args: [
          "api",
          "post",
          "/api/session",
          "--data",
          JSON.stringify({ agent: "worker", model, location: { directory: cwd } }),
        ],
        cwd,
        timeoutMs: 30000,
      });
      if (result.status !== "completed")
        return {
          ...sessionFailure,
          detail: `${result.detail} ${sessionFailure.detail}`,
          state: { invocationStatus: result.status },
        };
      if (result.exitCode !== 0)
        return {
          ...sessionFailure,
          detail: `OpenCode session creation exited ${result.exitCode}. ${sessionFailure.detail}`,
          state: { exitCode: result.exitCode },
        };
      const { data } = createdSession.parse(JSON.parse(result.stdout));
      if (
        data.location.directory !== cwd ||
        data.model.providerID !== model.providerID ||
        data.model.id !== model.id ||
        data.model.variant !== model.variant
      )
        return { ...sessionFailure, state: { sessionMatches: false } };
      return { args: ["--session", data.id] };
    },
    (cause, defect) =>
      cause instanceof SyntaxError || cause instanceof z.ZodError
        ? { ...sessionFailure, state: { responseValid: false } }
        : defect(cause),
  ).flatMap((result) => ("reason" in result ? Err(result) : Ok(result.args)));
}

function qualify<T>(cause: Error, defect: (cause: Error) => T): HostFailure | T {
  const failure = {
    reason: "host_metadata_failed" as const,
    detail:
      "The host did not return valid model and effort metadata. No selection was substituted.",
    next: {
      decider: "super-agent" as const,
      question: "How should valid host model metadata be restored before selecting a launch?",
    },
  };
  if (cause instanceof SyntaxError || cause instanceof z.ZodError)
    return { ...failure, state: { metadataValid: false } };
  if (isCodedError(cause) && ["ENOENT", "EACCES", "EPERM", "EIO", "ENOTDIR"].includes(cause.code))
    return { ...failure, state: { code: cause.code } };
  return defect(cause);
}

/** Host selection and startup contain no permission policy or fallback. */
export const AgentHosts = {
  models(input: { host: Host; cwd: string }) {
    return fromPromise(
      () => (input.host === "opencode" ? discoverOpenCode(input.cwd) : discoverClaude(input.cwd)),
      (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
    ).flatMap((models) => ("reason" in models ? Err(models) : Ok(models)));
  },
  resolve(input: LaunchSelection & { cwd: string }) {
    return AgentHosts.models(input).flatMap(
      (models): Result<ResolvedLaunch, HostFailure & ResultContext> => {
        const model = models.find(
          (candidate) => candidate.model === input.model || candidate.resolvedModel === input.model,
        );
        if (model === undefined)
          return Err({
            reason: "unsupported_model" as const,
            next: {
              command: `operator host models --host ${input.host}`,
              why: "Read the advertised models before selecting a launch model.",
            },
            state: { model: input.model, modelAdvertised: false },
            detail: `${input.host} does not advertise model ${input.model}. Select a model from operator host models.`,
          });
        if (!model.efforts.includes(input.reasoningEffort))
          return Err({
            reason: "unsupported_effort" as const,
            next: {
              command: `operator host models --host ${input.host}`,
              why: "Read the advertised efforts before selecting a launch effort.",
            },
            state: { model: input.model, effort: input.reasoningEffort, effortAdvertised: false },
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
                  args: [],
                }
              : {
                  tool: "claude",
                  args: ["--model", resolvedModel, "--effort", input.reasoningEffort],
                },
        });
      },
    );
  },
  /** Mini does not load Herdr's terminal plugin. The full TUI takes a session, not --model. */
  start(input: { launch: ResolvedLaunch; cwd: string; name: string; paneId: string }) {
    const { launch, cwd, name, paneId } = input;
    const args =
      launch.host === "opencode" ? openCodeArguments(launch, cwd) : OkAsync(launch.command.args);
    return args.flatMap((args) =>
      Herdr.startAgent({
        name,
        paneId,
        kind: launch.host === "opencode" ? "opencode" : "claude",
        args,
      }),
    );
  },
};
