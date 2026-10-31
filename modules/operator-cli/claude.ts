import { ClaudeHook } from "../claude-hook/main.ts";

/**
 * Claude Code runs the hook before a git command and reads only Claude Code JSON from it. The
 * hook reads no device state, so it runs before the state check. A failure exits 1, which Claude
 * Code shows to the person and treats as no decision.
 */
export async function runClaudeHook(args: string[]) {
  if (args.length !== 2 || args[0] !== "claude" || args[1] !== "hook") return false;
  const result = await ClaudeHook.answer(await Bun.stdin.text());
  if (result.tag === "Ok") {
    if (result.value !== "") console.log(result.value);
    process.exitCode = 0;
  } else {
    console.error(`operator: ${result.tag === "Err" ? result.error.detail : String(result.cause)}`);
    process.exitCode = 1;
  }
  return true;
}
