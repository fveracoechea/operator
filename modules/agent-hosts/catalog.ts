import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { Environment } from "../environment/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";

export type Host = "opencode" | "claude-code";
export type HostFailure = {
  reason: "host_unavailable" | "host_metadata_failed" | "unsupported_model" | "unsupported_effort";
  detail: string;
};
export type Model = { model: string; resolvedModel?: string; efforts: string[] };

const claudeCatalog = z.array(
  z.object({
    value: z.string().min(1),
    resolvedModel: z.string().min(1).optional(),
    supportsEffort: z.boolean().optional(),
    supportedEffortLevels: z.array(z.string().min(1)).optional(),
  }),
);

const openCodeCatalog = z.object({
  location: z.object({ directory: z.string() }),
  data: z.array(
    z.object({
      providerID: z.string().min(1),
      id: z.string().min(1),
      enabled: z.boolean(),
      variants: z.array(z.object({ id: z.string().min(1) })),
    }),
  ),
});

export async function discoverOpenCode(cwd: string): Promise<Model[] | HostFailure> {
  const result = await ToolInvocation.run({
    tool: "opencode",
    args: ["api", "get", `/api/model?location%5Bdirectory%5D=${encodeURIComponent(cwd)}`],
    cwd,
    timeoutMs: 10000,
  });
  if (result.status !== "completed")
    return {
      reason: result.status === "unavailable" ? "host_unavailable" : "host_metadata_failed",
      detail: result.detail,
    };
  if (result.exitCode !== 0)
    return { reason: "host_metadata_failed", detail: "OpenCode could not read its model catalog." };
  const parsed = openCodeCatalog.parse(JSON.parse(result.stdout));
  if (parsed.location.directory !== cwd)
    return {
      reason: "host_metadata_failed",
      detail: "OpenCode returned metadata for a different directory.",
    };
  return parsed.data
    .filter((model) => model.enabled)
    .map((model) => ({
      model: `${model.providerID}/${model.id}`,
      efforts: model.variants.map((variant) => variant.id),
    }));
}

export async function discoverClaude(cwd: string): Promise<Model[] | HostFailure> {
  const executable = Bun.which("claude", { PATH: Environment.read().PATH });
  if (executable === null)
    return {
      reason: "host_unavailable",
      detail: "claude is not on PATH. Install Claude Code before selecting it.",
    };
  const { query, AbortError } = await import("@anthropic-ai/claude-agent-sdk");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  // An open input stream permits metadata initialization, but sends no user message or generation request.
  const prompt = new ReadableStream<SDKUserMessage>({
    start(stream) {
      controller.signal.addEventListener("abort", () => stream.close(), { once: true });
    },
  });
  let session: ReturnType<typeof query> | undefined;
  try {
    session = query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: executable,
        cwd,
        env: Environment.child(),
        abortController: controller,
        persistSession: false,
      },
    });
    const models = claudeCatalog.parse(await session.supportedModels());
    return models
      .filter((model) => !["default", "opusplan"].includes(model.value))
      .map((model) => ({
        model: model.value,
        resolvedModel: model.resolvedModel,
        efforts: model.supportsEffort === true ? (model.supportedEffortLevels ?? []) : [],
      }));
  } catch (cause) {
    if (
      cause instanceof Error &&
      (cause instanceof AbortError ||
        /^Claude Code process (?:exited with code \d+|terminated by signal SIG[A-Z0-9]+)/.test(
          cause.message,
        ))
    )
      return {
        reason: "host_metadata_failed",
        detail: "Claude Code metadata initialization failed. No selection was substituted.",
      };
    // oxlint-disable-next-line unthrown/no-throw -- Only known SDK termination failures are modeled. Preserve unexpected defects for the host boundary.
    throw cause;
  } finally {
    clearTimeout(timer);
    controller.abort();
    session?.close();
  }
}
