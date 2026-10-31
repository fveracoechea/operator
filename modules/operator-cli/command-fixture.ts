// Bun has no symlink API.
import { symlink } from "node:fs/promises";
import { Environment } from "../environment/main.ts";

const cli = Bun.fileURLToPath(new URL("../../cli.ts", import.meta.url));

/**
 * The command that the workflow fixtures run.
 * The installed delivery smoke names an installed `operator` in `OPERATOR_INSTALLED_COMMAND`, so
 * the same workflows run through that installation and not through this checkout.
 * The variable is a test input only. The CLI never reads it.
 */
export function fixtureCommand() {
  // `Environment.read()` validates only the variables the CLI uses, and this test input is not one
  // of them, so the fixture reads it from the child map that passes unknown variables on.
  const installed = Environment.child().OPERATOR_INSTALLED_COMMAND;
  const argv = installed === undefined ? [process.execPath, cli] : [installed];

  return {
    argv,
    /**
     * Puts `operator` in the fixture's tools folder. Readiness accepts only a command that runs
     * the running release, so a fixture that ran another release would not be ready.
     */
    async link(tools: string) {
      await symlink(installed ?? cli, `${tools}/operator`);
    },
  };
}

/** Claude Code user settings that run the commit hook, as a ready Claude Code device has. */
export async function writeClaudeHookSettings(home: string) {
  const settings = { hooks: { PreToolUse: [{ hooks: [{ command: "operator claude hook" }] }] } };
  await Bun.write(`${home}/.claude/settings.json`, JSON.stringify(settings), { createPath: true });
}
