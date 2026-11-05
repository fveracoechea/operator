import { OpenCodePlugin } from "../opencode-plugin/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";

/**
 * Operator's OpenCode plugin runs the hook before a git commit and when a session goes idle, and
 * reads only its own JSON from it. The commit check reads no device state, and the idle guard has
 * no opinion when state is not usable, so the hook runs before the state check. A failure exits 1,
 * which the plugin treats as no opinion.
 */
export async function runOpenCodeHook(
  args: string[],
  paths: ReturnType<typeof OperatorHome.resolve>,
) {
  if (args.length !== 2 || args[0] !== "opencode" || args[1] !== "hook") return false;
  const result = await OpenCodePlugin.answer({ event: await Bun.stdin.text(), paths });
  if (result.tag === "Ok") {
    if (result.value !== "") console.log(result.value);
    process.exitCode = 0;
  } else {
    console.error(`operator: ${result.tag === "Err" ? result.error.detail : String(result.cause)}`);
    process.exitCode = 1;
  }
  return true;
}
