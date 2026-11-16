import { ClaudeHook } from "../claude-hook/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { failure } from "./output.ts";
import { workflowRefusal } from "./workflow-refusal.ts";

/**
 * Claude Code runs the hook before a git command and at a turn's end, and reads only Claude Code
 * JSON from it. The commit check reads no device state, and the turn-end guard allows the stop when
 * state is not usable, so the hook runs before the state check. A failure exits 1, which Claude
 * Code shows to the person and treats as no decision.
 */
export async function runClaudeHook(
  args: string[],
  paths: ReturnType<typeof OperatorHome.resolve>,
) {
  if (args.length !== 2 || args[0] !== "claude" || args[1] !== "hook") return false;
  const result = await ClaudeHook.answer({ event: await Bun.stdin.text(), paths });
  if (result.tag === "Ok") {
    if (result.value !== "") console.log(result.value);
    process.exitCode = 0;
  } else {
    failure(
      // Stryker disable next-line StringLiteral: equivalent: The adapter calls failure with json=false. Its operation argument is used only inside the disabled JSON output branch, while the separate owner/defect context supplies observable stderr.
      "claude_hook",
      result.tag === "Err" ? result.error.reason : "claude_hook_defect",
      result.tag === "Err" ? result.error.detail : String(result.cause),
      1,
      false,
      result.tag === "Err"
        ? result.error
        : workflowRefusal("claude_hook", "claude_hook_defect", {}),
    );
  }
  return true;
}
