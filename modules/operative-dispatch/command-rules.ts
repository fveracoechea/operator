/** One rule a command refuses, with the refusal name that command reports when it is broken. */
export type CommandRule = { rule: string; refusal: string };

/**
 * Every command an Operative runs finds its attempt through the control reference this module
 * writes into the worktree, so this module owns the rules of that reference.
 * The Operative never opens the reference: the brief carries every fact it holds.
 */
export const REFERENCE_RULES: CommandRule[] = [
  {
    refusal: "attempt_reference_missing",
    rule: "Run this from this worktree.",
  },
  {
    refusal: "attempt_reference_malformed",
    rule: "Never change a file that the Operator wrote under `.operator/local/`.",
  },
];

/** A command that names `--attempt` also refuses a worktree of another attempt. */
export const ATTEMPT_REFERENCE_RULES: CommandRule[] = [
  ...REFERENCE_RULES,
  {
    refusal: "attempt_reference_mismatch",
    rule: "`--attempt` is the attempt in the Identity section.",
  },
];

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
