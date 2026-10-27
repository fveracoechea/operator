import type { WorkSources } from "../work-sources/main.ts";

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
  pullRequest: { number: number; url: string } | null;
  dependencyReports: ReturnType<typeof WorkSources.dependencyReports>;
};

function list(files: string[], directory: string) {
  return files.length === 0
    ? "- None."
    : files.map((file) => `- \`${directory}/${file}\``).join("\n");
}

/** Worker text stays inside its block, so it cannot open a brief section. */
function quote(text: string) {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** The content is copied, because a reset or removal can delete the producer's report file. */
function dependencyReports(input: BriefInput) {
  if (input.dependencyReports.length === 0) return "";
  const reports = input.dependencyReports.map(
    (row) => `### \`${row.assignment}\` report ${row.report}

Reference: \`${row.reference}\`

${quote(row.conclusion)}

Unresolved points:

${row.unresolved.length === 0 ? "- None." : row.unresolved.map((point) => `- ${point.replaceAll("\n", "\n  ")}`).join("\n")}
`,
  );
  return `
## Accepted dependency reports

The SuperAgent accepted these reports of the assignments that this work depends on.
Check whether each unresolved point applies to your task. Tell your supervising SuperAgent about each point that does.

${reports.join("\n")}`;
}

function feedbackLoop(input: BriefInput) {
  if (input.completion !== "pr") return "";
  const opened =
    input.pullRequest === null
      ? [
          "Open one PR from your branch with your own tools. Use closing keywords for tracker issues.",
          "Then run `operator pr associate --json` in your worktree.",
        ]
      : [
          `PR #${input.pullRequest.number} is already open for this assignment: ${input.pullRequest.url}.`,
          "Read its reviews, comments, unresolved threads, and checks before you wait.",
          "Inspect the worktree first. Keep work that is not landed.",
        ];
  return `
## PR feedback loop

${opened.join("\n")}
Run \`operator pr wait --json\` in your worktree, and repeat it after you handle each result.
Check each claim in feedback, reply, and push fixes to the same PR.
A \`pr_wait_timed_out\` result is visible to your SuperAgent until you wait again.
After \`merge_eligible\`, run \`operator pr merge --json\`. It checks GitHub again, merges, and then closes this pane.
PR commands select your assignment only through this worktree.
`;
}

function prSteps(directory: string) {
  return [
    "- Give a short conclusion, evidence references, unresolved points, and paths to detailed files.",
    `- Put detailed supporting files in \`${directory}\`.`,
  ].join("\n");
}

/** Submission is durable in device state, and only the SuperAgent completes a report. */
function reportSteps(directory: string) {
  return [
    "- Write a JSON report outside the project checkout with `conclusion`, `evidence`, `unresolved`, and optional `decisions` and `files`.",
    "- `evidence` and `unresolved` are lists of short text. `files` lists absolute paths of detailed supporting files.",
    "- Each decision has `question`, `answer`, and `by`. Use `person` only for an answer that the person gave. Use `super-agent` for a SuperAgent decision.",
    "- Submit it from this pane with `operator report submit --file <path> --json`, then tell your supervising SuperAgent.",
    `- Operator stores the report and copies of the supporting files in \`${directory}\`.`,
    "- Submission does not complete the assignment. The SuperAgent accepts the report or returns follow-up instructions.",
    "- When you receive follow-up instructions, run `operator report resume --json` in this pane before you continue, then submit a new report.",
  ].join("\n");
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

${input.instructions}
${dependencyReports(input)}
## Grilling authority

The task instructions state who answers questions and what the SuperAgent may decide.
Send each question to your supervising SuperAgent, not to the person.
The SuperAgent asks the person when the instructions require human participation, when a question is outside its delegated authority, or when that authority is unclear.
A SuperAgent answer is a SuperAgent decision, not a human answer, also after it accepts your work.

## Native subagents

Native host subagents work inside this assignment, and you remain responsible for their work and evidence.
Work that needs its own scheduling, dependencies, or acceptance needs a separate assignment. Ask your supervising SuperAgent for it.

## Skills

Load the \`worker-agent\` skill.
Load each other skill that the task instructions name.

## Resources

${resources.join("\n")}
- Operator keeps coordination files in device state, not in the checkout.

## Results and reporting

- Report to your supervising SuperAgent through Herdr, not directly to the person.
${input.completion === "report" ? reportSteps(input.reports.directory) : prSteps(input.reports.directory)}
- Herdr activity does not prove that the work is submitted or complete.
${feedbackLoop(input)}
## Earlier reports

${list(input.reports.files, input.reports.directory)}

## Follow-up instructions

${list(input.followUps.files, input.followUps.directory)}
`;
}
