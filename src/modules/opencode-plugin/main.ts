import path from "node:path";
import { Err, Ok, fromPromise, fromThrowable } from "unthrown";
import { z } from "zod";
import { isCodedError } from "../../lib/coded-error.ts";
import { AgentGuards } from "../agent-guards/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { installPlugin } from "./install.ts";

// The plugin file sends these events. Its version marker changes with them.
const eventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("tool.execute.before"),
    directory: z.string(),
    // The shell tool's input. Input with no command describes no command to check.
    // Stryker disable next-line StringLiteral: equivalent: any text that is not a git commit has no trailer
    input: z.looseObject({ command: z.string(), workdir: z.string().optional() }).catch({
      command: "",
    }),
  }),
  z.object({ event: z.literal("session.idle"), directory: z.string(), sessionID: z.string() }),
]);

/**
 * Operator's OpenCode plugin file and the answers that `operator opencode hook` gives it.
 * The plugin only refuses a commit or continues a session once for each person prompt. It never
 * allows a tool, so OpenCode keeps its own permission flow.
 */
export const OpenCodePlugin = {
  /**
   * Answers one plugin event with the reason for standard output. On a tool event the plugin
   * refuses the call with it, and on an idle event it continues the session with it. Empty text
   * has no opinion. Only the idle event reads device state, so the commit check works without it.
   */
  answer(input: { event: string; paths: ReturnType<typeof OperatorHome.resolve> }) {
    return fromThrowable(
      () => eventSchema.parse(JSON.parse(input.event)),
      (cause, defect) =>
        // Stryker disable next-line ConditionalExpression: equivalent: JSON.parse and the schema throw only these errors
        cause instanceof SyntaxError || cause instanceof z.ZodError
          ? {
              reason: "opencode_hook_event_invalid" as const,
              // Stryker disable next-line StringLiteral: no rule: the diagnostic wording is not a promised result
              detail: "The OpenCode plugin did not describe a hook event.",
            }
          : defect(cause),
    )()
      .toAsync()
      .flatMap((parsed) =>
        parsed.event === "session.idle"
          ? // The idle session itself is the supervisor that the guard asks for, so a subagent's
            // session or another session in the supervising pane gets no reason.
            AgentGuards.turnEnd({
              paths: input.paths,
              cwd: parsed.directory,
              session: parsed.sessionID,
            }).map((reason) => reason ?? "")
          : AgentGuards.commit({
              command: parsed.input.command,
              cwd: path.resolve(parsed.directory, parsed.input.workdir ?? "."),
            }).map((reason) => reason ?? ""),
      );
  },
  /** Check mode, a Nix release, and readiness only read the plugin file. */
  install(input: { paths: ReturnType<typeof OperatorHome.resolve>; check: boolean }) {
    return fromPromise(
      async () => {
        OperatorHome.guardTemporaryTests(Environment.read(), [
          path.dirname(input.paths.opencodePlugin),
        ]);
        return installPlugin({ file: input.paths.opencodePlugin, check: input.check });
      },
      (cause, defect) =>
        isCodedError(cause) &&
        [
          "ENOENT",
          "EACCES",
          "EPERM",
          "EIO",
          "EROFS",
          "ENOSPC",
          "ENOTDIR",
          "EISDIR",
          "EEXIST",
          "ELOOP",
        ].includes(cause.code)
          ? { reason: "opencode_plugin_io_failed" as const, detail: String(cause) }
          : defect(cause),
    ).flatMap((outcome) => ("detail" in outcome ? Err(outcome) : Ok(outcome.reason)));
  },
};
