import path from "node:path";
import { Err, Ok, fromPromise, fromThrowable } from "unthrown";
import { z } from "zod";
import { isCodedError } from "../../lib/coded-error.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { commitHasTrailer } from "./commit.ts";
import { installHook } from "./settings.ts";

const eventSchema = z.object({
  hook_event_name: z.string(),
  tool_name: z.string(),
  // Only Bash input has a command. Other tools describe no command to check.
  tool_input: z.looseObject({ command: z.string().catch("") }),
  cwd: z.string(),
});

const deny = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason:
      "Commit messages carry no Co-Authored-By trailer. Remove every Co-Authored-By line from the message, then commit again.",
  },
});

/**
 * Operator's Claude Code hook and its entry in the person's user settings.
 * The hook only denies. It never allows a tool, so Claude Code keeps its own permission flow.
 */
export const ClaudeHook = {
  /** Answers one hook event with the text for standard output. Empty text has no opinion. */
  answer(event: string) {
    return fromThrowable(
      () => eventSchema.parse(JSON.parse(event)),
      (cause, defect) =>
        cause instanceof SyntaxError || cause instanceof z.ZodError
          ? {
              reason: "claude_hook_event_invalid" as const,
              detail: "Claude Code did not describe a hook event.",
            }
          : defect(cause),
    )()
      .toAsync()
      .flatMap((parsed) =>
        fromPromise(
          async () =>
            parsed.hook_event_name === "PreToolUse" &&
            parsed.tool_name === "Bash" &&
            (await commitHasTrailer(parsed.tool_input.command, parsed.cwd))
              ? deny
              : "",
          (cause, defect) => defect(cause),
        ),
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
        isCodedError(cause) && ["EACCES", "EPERM", "EROFS", "EIO", "EISDIR"].includes(cause.code)
          ? { reason: "claude_settings_io_failed" as const, detail: String(cause) }
          : defect(cause),
    ).flatMap((outcome) => ("detail" in outcome ? Err(outcome) : Ok(outcome.reason)));
  },
};
