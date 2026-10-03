/** One rule a command refuses, with the refusal name that command reports when it is broken. */
export type CommandRule = { rule: string; refusal: string };

/**
 * Every command an Operative runs finds its attempt through the control reference this module
 * writes into the worktree, so this module owns the rule that the command runs from there.
 */
export const REFERENCE_RULE: CommandRule = {
  refusal: "attempt_reference_missing",
  rule: "Run this and every later command of this brief from this worktree.",
};

/**
 * The refusals one command gives, written once beside that command.
 * The module that runs each check owns its line, so a brief places it and never words it.
 */
export function ruleLines(rules: CommandRule[]): string[] {
  return rules.length === 0
    ? []
    : [
        "This command refuses, with the named reason, when you break one of its rules:",
        "",
        ...rules.map((one) => `- \`${one.refusal}\`: ${one.rule}`),
        "",
      ];
}
