type BriefInput = {
  sourceId: string;
  sourceTrackerKey: string;
  assignment: string;
  trackerKey: string;
  completion: "pr" | "report";
  profile: string | null;
  instructions: string;
  workingDirectory: string;
  resources: { kind: "pane" } | { kind: "worktree"; branch: string };
  reports: { directory: string; files: string[] };
  followUps: { directory: string; files: string[] };
};

function list(files: string[], directory: string) {
  return files.length === 0
    ? "- None."
    : files.map((file) => `- \`${directory}/${file}\``).join("\n");
}

/**
 * The running release's brief template. A new start rewrites the brief from this template.
 * It names no runtime agent, pane, or host, because a replacement reads the same brief.
 */
export function renderBrief(input: BriefInput) {
  const resources =
    input.resources.kind === "worktree"
      ? [
          `- Work in the isolated Herdr worktree \`${input.workingDirectory}\` on branch \`${input.resources.branch}\`.`,
          "- Change project files only in this worktree.",
        ]
      : [
          `- Work in a separate pane of the controlling checkout \`${input.workingDirectory}\`.`,
          "- This is read-only work. Do not change project files, branches, or worktrees.",
        ];
  return `# Assignment brief

Operator writes this brief at each start of the assignment.
Read all of it before you start.

## Task

- Source: \`${input.sourceId}\`, tracker key \`${input.sourceTrackerKey}\`.
- Assignment: \`${input.assignment}\`, tracker key \`${input.trackerKey}\`.
- Completion type: ${input.completion === "pr" ? "a merged pull request" : "a report that the SuperAgent accepts"}.
- Start profile: ${input.profile === null ? "the device default" : `\`${input.profile}\``}.

The task instructions below also state your decision authority.
Ask your supervising SuperAgent when that authority is unclear.

${input.instructions}

## Skills

Load the \`worker-agent\` skill.
Load each other skill that the task instructions name.

## Resources

${resources.join("\n")}
- Operator keeps coordination files in device state, not in the checkout.

## Results and reporting

- Report to your supervising SuperAgent through Herdr, not directly to the person.
- Give a short conclusion, evidence references, unresolved points, and paths to detailed files.
- Put detailed supporting files in \`${input.reports.directory}\`.
- Herdr activity does not prove that the work is submitted or complete.

## Earlier reports

${list(input.reports.files, input.reports.directory)}

## Follow-up instructions

${list(input.followUps.files, input.followUps.directory)}
`;
}
