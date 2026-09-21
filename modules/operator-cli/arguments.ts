export type AgentTarget = "opencode" | "claude-code";

export type ParsedArguments = {
  json: boolean;
  targets: AgentTarget[];
  approvedPlan: string | undefined;
  unsupported: string[];
};

// Operator uses its own short flags; the recorded host identifiers stay the full host names.
const targetByFlag = { "--opencode": "opencode", "--claude": "claude-code" } as const;
const flagByTarget = { opencode: "--opencode", "claude-code": "--claude" } as const;

export function targetFlag(target: AgentTarget): string {
  return flagByTarget[target];
}

export function parseArguments(args: string[]): ParsedArguments {
  const parsed: ParsedArguments = {
    json: false,
    targets: [],
    approvedPlan: undefined,
    unsupported: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      parsed.json = true;
    } else if (argument === "--opencode" || argument === "--claude") {
      const target = targetByFlag[argument];
      if (!parsed.targets.includes(target)) {
        parsed.targets.push(target);
      }
    } else if (argument === "--approved-plan") {
      index += 1;
      const value = args[index];
      if (value === undefined || value.startsWith("--")) {
        parsed.unsupported.push("--approved-plan");
      } else {
        parsed.approvedPlan = value;
      }
    } else if (argument !== undefined) {
      parsed.unsupported.push(argument);
    }
  }

  return parsed;
}
