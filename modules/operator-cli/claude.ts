import { ClaudeHook } from "../claude-hook/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";

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
    console.error(`operator: ${result.tag === "Err" ? result.error.detail : String(result.cause)}`);
    process.exitCode = 1;
  }
  return true;
}
