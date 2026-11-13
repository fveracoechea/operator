import type { WorkSources } from "../work-sources/main.ts";
import type { Adoption } from "./adoption.ts";

type Finding = { axis: string; severity: string; location: string; claim: string };

type BriefInput = {
  sourceId: string;
  sourceTrackerKey: string;
  assignment: string;
  trackerKey: string;
  completion: "pr" | "report";
  profile: string | null;
  instructions: string;
  /** The person's own words, or null when neither the assignment nor the plan gives them. */
  intent: string | null;
  workingDirectory: string;
  /** The worktree branch, or null for read-only work in a pane of the checkout. */
  branch: string | null;
  reports: { directory: string; files: string[] };
  followUps: { directory: string; files: string[] };
  pullRequest: { number: number; url: string } | null;
  dependencyReports: ReturnType<typeof WorkSources.dependencyReports>;
  /** The open parent PR that this PR stacks on, when it has one. */
  stack: { assignment: string; number: number; branch: string } | null;
  /** The launch's resolved internal review value. Only a PR assignment uses it. ADR-0020. */
  internalReview: boolean;
  /** The recorded internal review of the PR, which makes this start its reviewer while it runs. */
  review: {
    state: "reviewing" | "ready" | "skipped";
    rounds: { number: number; head: string; findings: Finding[] }[];
    /** The PR head that an ended review recorded. */
    readyHead: string | null;
  } | null;
  /** The accepted report that this PR assignment was promoted from. ADR-0023. */
  promotion: { report: string; number: number } | null;
  /** The open PR that this assignment adopts, until its owner associates it. ADR-0024. */
  adoption: Adoption | null;
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

/** The person's words are the acceptance criteria, and the instructions are the SuperAgent's spec. */
function acceptanceCriteria(input: BriefInput) {
  if (input.intent === null) return "";
  return `
## Acceptance criteria

The person gave these words for this work. They are its acceptance criteria.
The task instructions above are the SuperAgent's spec for meeting them. Ask your supervising SuperAgent when the two disagree.

${quote(input.intent)}
`;
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
Check whether each unresolved point applies to your task. Record a question for your supervising SuperAgent about each point that does.

${reports.join("\n")}`;
}

/** The promoted worktree can hold prototype changes that the PR must not keep. ADR-0023. */
function promotion(input: BriefInput) {
  if (input.promotion === null) return "";
  return `
## Promotion

The SuperAgent promoted report ${input.promotion.number} of \`${input.promotion.report}\` into this PR assignment.
You work in that report's worktree, and its accepted report is listed above.
The worktree can hold prototype changes that the PR must not keep. Clean the branch before your first push.
`;
}

/** The relay and the guarded merge own a stack, so a `gh stack` write would race them. ADR-0010. */
const stackRule = [
  "Use `gh stack view --json` only to read a stack.",
  "Run no other `gh stack` command, because the relay and `operator pr merge` own the rebase, push, base change, and merge.",
];

function findingLine(finding: Finding) {
  return `  - ${finding.axis}, ${finding.severity}, \`${finding.location}\`: ${finding.claim.replaceAll("\n", " ")}`;
}

/** The reviewer role comes from the recorded review, not from the PR's draft state. */
function reviewer(number: number, review: NonNullable<BriefInput["review"]>) {
  const rounds = review.rounds.map((round) =>
    [
      `- Round ${round.number} at \`${round.head}\`: ${round.findings.length === 0 ? "no findings." : ""}`.trimEnd(),
      ...round.findings.map(findingLine),
    ].join("\n"),
  );
  return [
    `You are the internal reviewer of PR #${number}. Operator ended the implementer's session and started you in its worktree.`,
    "Read the `internal-review.md` topic of the `worker-agent` skill before you start.",
    "Do not use the PR body, the commit messages, or earlier owner messages as evidence.",
    "Record each round's findings with `operator pr round --file <findings.json> --json` before you change code.",
    ...(rounds.length === 0 ? ["No round is recorded yet."] : ["Recorded rounds:", ...rounds]),
    "End the review with `operator pr ready --file <summary.json> --json`. It posts the summary comment and marks the PR ready. Do not mark the PR ready yourself.",
    "Then you own the PR feedback loop below.",
  ];
}

/** A launch after the review ended owns the PR, also when its review ended in an earlier launch. */
function reviewEnded(number: number, review: NonNullable<BriefInput["review"]>) {
  const end =
    review.state === "ready"
      ? `The internal review of PR #${number} ended ready at \`${review.readyHead ?? ""}\`.`
      : `The internal review of PR #${number} was skipped on the person's instruction at \`${review.readyHead ?? ""}\`.`;
  return [end, "You own the PR. Record no more review rounds."];
}

/** The adopted PR holds work and review threads that the owner must read first. ADR-0024. */
function adopted(adoption: Adoption) {
  return [
    `You adopt ${adoption.draft ? "draft " : ""}PR #${adoption.number}, which Operator did not open: ${adoption.url}.`,
    "Your worktree is on its branch. Do not open another PR, and do not rewrite commits that the PR already has.",
    "Read the PR, its reviews, comments, unresolved review threads, and checks before you change code or wait.",
  ];
}

function feedbackLoop(input: BriefInput) {
  if (input.completion !== "pr") return "";
  const base =
    input.stack === null
      ? "Target the default branch."
      : `Your branch starts on \`${input.stack.branch}\`, the branch of PR #${input.stack.number} of assignment \`${input.stack.assignment}\`. Target that branch as the PR base.`;
  // With internal review on, the implementer's work ends at associate, and a reviewer owns the PR.
  if (input.pullRequest === null && input.internalReview)
    return `
## PR feedback loop

${[
  "Internal review is on for this assignment.",
  ...(input.adoption === null
    ? [
        "Open one draft PR from your branch with your own tools. Use closing keywords for tracker issues.",
      ]
    : [...adopted(input.adoption), "Keep the PR a draft."]),
  base,
  ...(input.stack === null ? [] : stackRule),
  "Commit all work and push with `git push -u`, so Git records the remote of your branch.",
  "Then run `operator pr associate --json` in your worktree.",
  "It refuses a PR that is not a draft, and a worktree with uncommitted, untracked, or unpushed work. Fix the cause and run it again.",
  "Do not mark the PR ready for review.",
  "After the association, Operator ends this session and starts a fresh reviewer in this worktree. The reviewer owns the PR until its merge.",
  "Stop once the association succeeds. Your SuperAgent sees the handoff in `operator next`, so send it no message.",
].join("\n")}
`;
  const opened =
    input.pullRequest === null && input.adoption !== null
      ? [
          ...adopted(input.adoption),
          ...(input.adoption.draft
            ? [
                "Internal review is off for this assignment.",
                "Mark the draft ready for review with `gh pr ready` before your first wait, because the merge needs a ready PR.",
              ]
            : ["The PR is ready for review, so it gets no internal review."]),
          base,
          "Push your fixes with `git push -u`, so Git records the remote of your branch.",
          "Run `operator pr associate --json` in your worktree before your first wait. It records the PR for this assignment.",
        ]
      : input.pullRequest === null
        ? [
            "Open one PR from your branch with your own tools. Use closing keywords for tracker issues.",
            base,
            "Push with `git push -u`, so Git records the remote of your branch.",
            "Then run `operator pr associate --json` in your worktree.",
          ]
        : [
            `PR #${input.pullRequest.number} is already open for this assignment: ${input.pullRequest.url}.`,
            ...(input.review === null
              ? []
              : input.review.state === "reviewing"
                ? reviewer(input.pullRequest.number, input.review)
                : reviewEnded(input.pullRequest.number, input.review)),
            "Read its reviews, comments, unresolved threads, and checks before you wait.",
            "Inspect the worktree first. Keep work that is not landed.",
          ];
  return `
## PR feedback loop

${opened.join("\n")}
Run \`operator pr wait --json\` in your worktree, and repeat it after you handle each result.
Check each claim in feedback, reply, and push fixes to the same PR.
A \`pr_wait_timed_out\` result is visible to your SuperAgent until you wait again.
When a stacked PR's parent merges, the wait rebases your branch onto the default branch, pushes it, and changes the PR base.
It returns \`parent_relayed\`, or a \`relay_*\` blocker that you resolve before you wait again. Keep all work.
${stackRule.join("\n")}
After \`merge_eligible\`, run \`operator pr merge --json\`. It checks GitHub again, merges, and then closes this pane.
PR commands select your assignment only through this worktree.
`;
}

function prSteps(directory: string) {
  return [
    "- In the PR body, give a short conclusion, evidence references, and unresolved points.",
    `- Put detailed supporting files in \`${directory}\`, where your SuperAgent reads them.`,
  ].join("\n");
}

/** Submission is durable in device state, and only the SuperAgent completes a report. */
function reportSteps(directory: string) {
  return [
    "- Write a Markdown report outside the checkout with headings `## Conclusion`, `## Evidence`, `## Unresolved points`, `## Supporting files`, `## Human answers`, and `## SuperAgent decisions`.",
    "- Write the conclusion as prose. Other sections use `- ` bullets, or `- None.` when empty. Supporting files use absolute paths.",
    "- Decision bullets read `<question> Answer: <answer>`. Human answers record only the person's own answers. SuperAgent decisions stay in their own section.",
    "- Submit it from this pane with `operator report submit --file <path> --json`. Your SuperAgent's coordination wait returns it, so send no message.",
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
    input.branch === null
      ? [
          `- Work in a separate pane of the controlling checkout \`${input.workingDirectory}\`.`,
          "- This is read-only work. Do not change project files, branches, or worktrees.",
        ]
      : [
          `- Work in the isolated Herdr worktree \`${input.workingDirectory}\` on branch \`${input.branch}\`.`,
          "- Change project files only in this worktree.",
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
${acceptanceCriteria(input)}${dependencyReports(input)}${promotion(input)}
## Grilling authority

The task instructions state who answers questions and what the SuperAgent may decide.
Do the work within this task without asking for approval of each command or step. Decide what the instructions and the repository settle, and record those decisions in your report or PR.
Ask each question of your supervising SuperAgent, not of the person.
Record it with \`operator question ask\` from this pane, and read the answer with \`operator question wait\`, as the \`worker-agent\` skill describes.
The SuperAgent asks the person when the instructions require human participation, when a question is outside its delegated authority, or when that authority is unclear.
A SuperAgent answer is a SuperAgent decision, not a human answer, also after it accepts your work.

## Native subagents

Native host subagents work inside this assignment, and you remain responsible for their work and evidence.
Work that needs its own scheduling, dependencies, or acceptance needs a separate assignment. Request it in a recorded question to your supervising SuperAgent.

## Skills

Load the \`worker-agent\` skill.
Load each other skill that the task instructions name.

## Resources

${resources.join("\n")}
- Operator keeps coordination files in device state, not in the checkout.

## Results and reporting

- Report to your supervising SuperAgent only through recorded Operator state, not directly to the person. Never type into its pane.
${input.completion === "report" ? reportSteps(input.reports.directory) : prSteps(input.reports.directory)}
- Herdr activity does not prove that the work is submitted or complete.
${feedbackLoop(input)}
## Earlier reports

${list(input.reports.files, input.reports.directory)}

## Follow-up instructions

${list(input.followUps.files, input.followUps.directory)}
`;
}
