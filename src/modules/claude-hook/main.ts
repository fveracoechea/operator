import path from "node:path";
import { Err, Ok, OkAsync, fromPromise, fromThrowable } from "unthrown";
import { z } from "zod";
import { isCodedError } from "../../lib/coded-error.ts";
import { AgentGuards } from "../agent-guards/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { installHook } from "./settings.ts";

// Claude Code sets stop_hook_active while a turn continues because a Stop hook blocked its end.
const stopSchema = z.object({
  hook_event_name: z.literal("Stop"),
  session_id: z.string(),
  stop_hook_active: z.boolean(),
  cwd: z.string(),
});

const toolSchema = z.object({
  hook_event_name: z.string(),
  tool_name: z.string(),
  // Only Bash input has a command. Other tools describe no command to check.
  // Stryker disable next-line StringLiteral: equivalent: any text that is not a git commit has no trailer
  tool_input: z.looseObject({ command: z.string().catch("") }),
  cwd: z.string(),
});

const eventSchema = z.union([stopSchema, toolSchema]);

function deny(reason: string) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

/**
 * The turn-end guard of a SuperAgent session. A turn that a block continued may end, so the guard
 * blocks at most once in a row. Only the session that supervises a source gets the guard.
 */
function stop(input: {
  paths: ReturnType<typeof OperatorHome.resolve>;
  cwd: string;
  session_id: string;
  stop_hook_active: boolean;
}) {
  if (input.stop_hook_active) return OkAsync("");
  return AgentGuards.turnEnd({ paths: input.paths, cwd: input.cwd, session: input.session_id }).map(
    (reason) => (reason === null ? "" : JSON.stringify({ decision: "block", reason })),
  );
}

/**
 * Operator's Claude Code hook and its entries in the person's user settings.
 * The hook only denies a commit or blocks a turn's end once. It never allows a tool, so Claude
 * Code keeps its own permission flow.
 */
export const ClaudeHook = {
  /**
   * Answers one hook event with the text for standard output. Empty text has no opinion.
   * Only the Stop event reads device state, so the commit check works without it.
   */
  answer(input: { event: string; paths: ReturnType<typeof OperatorHome.resolve> }) {
    return fromThrowable(
      () => eventSchema.parse(JSON.parse(input.event)),
      (cause, defect) =>
        // Stryker disable next-line ConditionalExpression: equivalent: JSON.parse and the schema throw only these errors
        cause instanceof SyntaxError || cause instanceof z.ZodError
          ? {
              reason: "claude_hook_event_invalid" as const,
              // Stryker disable next-line StringLiteral: no rule: the diagnostic wording is not a promised result
              detail: "Claude Code did not describe a hook event.",
            }
          : defect(cause),
    )()
      .toAsync()
      .flatMap((parsed) =>
        "stop_hook_active" in parsed
          ? stop({ paths: input.paths, ...parsed })
          : parsed.hook_event_name === "PreToolUse" && parsed.tool_name === "Bash"
            ? AgentGuards.commit({ command: parsed.tool_input.command, cwd: parsed.cwd }).map(
                (reason) => (reason === null ? "" : deny(reason)),
              )
            : OkAsync(""),
      );
  },
  /** Check mode, and a Nix release, only read the settings. */
  install(input: { paths: ReturnType<typeof OperatorHome.resolve>; check: boolean }) {
    return fromPromise(
      async () => {
        OperatorHome.guardTemporaryTests(Environment.read(), [
          path.dirname(input.paths.claudeSettings),
        ]);
        return installHook({ file: input.paths.claudeSettings, check: input.check });
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
          ? { reason: "claude_settings_io_failed" as const, detail: String(cause) }
          : defect(cause),
    ).flatMap((outcome) => ("detail" in outcome ? Err(outcome) : Ok(outcome.reason)));
  },
};
