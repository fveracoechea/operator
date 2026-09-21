const targetChoice = "(--opencode | --claude | --opencode --claude)";

export const usage = [
  "Usage:",
  "  operator --version [--json]",
  `  operator install ${targetChoice} [--json]`,
  `  operator setup plan ${targetChoice} [--json]`,
  `  operator setup apply ${targetChoice} --approved-plan <planId> [--json]`,
  "  operator setup rollback [--json]",
].join("\n");
