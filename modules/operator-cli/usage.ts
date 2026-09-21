const targetChoice = "(--opencode | --claude | --opencode --claude)";
const selection = "[--operator-host <host>] [--operator-model <model>]";
const crewSelection = "[--crew-host <host>] [--crew-model <model>]";

export const usage = [
  "Usage:",
  "  operator --version [--json]",
  `  operator install ${targetChoice} [--json]`,
  `  operator setup plan ${targetChoice} [--json]`,
  `  operator setup apply ${targetChoice} --approved-plan <planId> [--json]`,
  "  operator setup rollback [--json]",
  `  operator setup readiness ${targetChoice} ${selection} ${crewSelection} [--json]`,
  `  operator setup probe plan ${targetChoice} ${selection} ${crewSelection} [--json]`,
  `  operator setup probe apply ${targetChoice} ${selection} ${crewSelection} --approved-probe <probeId> [--json]`,
  "",
  "A host is `opencode` or `claude-code`.",
].join("\n");
