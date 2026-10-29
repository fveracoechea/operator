import { expect, test } from "bun:test";
import { renderBrief } from "./brief.ts";

const input = {
  sourceId: "source-1",
  sourceTrackerKey: "APP-1",
  assignment: "implement",
  trackerKey: "APP-2",
  completion: "pr" as const,
  profile: "careful",
  instructions: "Implement the accepted report.",
  workingDirectory: "/worktrees/app-2",
  branch: "task/2",
  reports: { directory: "/state/reports", files: ["1.md"] },
  followUps: { directory: "/state/follow-ups", files: [] },
  pullRequest: null,
  dependencyReports: [],
  stack: null,
};

test("the brief carries the task, resources, results, and earlier history", () => {
  const brief = renderBrief(input);
  for (const text of [
    "Assignment: `implement`, tracker key `APP-2`",
    "a merged pull request",
    "`careful`",
    "Implement the accepted report.",
    "`worker-agent`",
    "worktree `/worktrees/app-2` on branch `task/2`",
    "`/state/reports/1.md`",
    "Report to your supervising SuperAgent",
  ])
    expect(brief).toContain(text);
  expect(brief).toContain("## Follow-up instructions\n\n- None.");
});

test("read-only work forbids project changes, and the brief names no runtime agent", () => {
  const brief = renderBrief({
    ...input,
    completion: "report",
    profile: null,
    branch: null,
    workingDirectory: "/checkout",
  });
  expect(brief).toContain("read-only work");
  expect(brief).toContain("the device default");
  expect(brief).not.toMatch(/pane id|agent name|claude|opencode/i);
});

test("a PR owner gets the feedback loop, and a replacement gets its open PR", () => {
  const first = renderBrief(input);
  expect(first).toContain("## PR feedback loop");
  expect(first).toContain("`operator pr associate --json`");
  expect(first).toContain("`operator pr wait --json`");
  const replacement = renderBrief({
    ...input,
    pullRequest: { number: 7, url: "https://github.com/example/one/pull/7" },
  });
  expect(replacement).toContain("PR #7 is already open");
  expect(replacement).toContain("Keep work that is not landed.");
  expect(replacement).not.toContain("operator pr associate");
  expect(renderBrief({ ...input, completion: "report" })).not.toContain("PR feedback loop");
});

test("a stacked PR targets its parent's branch, and the brief names the relay", () => {
  const stacked = renderBrief({
    ...input,
    stack: { assignment: "parent", number: 6, branch: "task/1-parent" },
  });
  expect(stacked).toContain(
    "Your branch starts on `task/1-parent`, the branch of PR #6 of assignment `parent`. Target that branch as the PR base.",
  );
  expect(stacked).toContain("`parent_relayed`");
  expect(stacked).not.toContain("Target the default branch.");
  expect(renderBrief(input)).toContain("Target the default branch.");
});

test("a report brief names the submission, resume, and authority rules", () => {
  const brief = renderBrief({
    ...input,
    completion: "report",
    reports: { directory: "/state/reports", files: ["1/report.md", "1/files/notes.md"] },
    followUps: { directory: "/state/follow-ups", files: ["1.md"] },
  });
  for (const text of [
    "`operator report submit --file <path> --json`",
    "`operator report resume --json`",
    "Use `person` only for an answer that the person gave.",
    "Submission does not complete the assignment.",
    "when a question is outside its delegated authority, or when that authority is unclear",
    "A SuperAgent answer is a SuperAgent decision, not a human answer",
    "Native host subagents work inside this assignment",
    "`/state/reports/1/files/notes.md`",
    "`/state/follow-ups/1.md`",
  ])
    expect(brief).toContain(text);
  expect(renderBrief(input)).not.toContain("operator report submit");
});

test("a consumer brief copies each accepted dependency report with its gaps and reference", () => {
  expect(renderBrief(input)).not.toContain("Accepted dependency reports");
  const brief = renderBrief({
    ...input,
    dependencyReports: [
      {
        assignment: "investigate",
        report: 2,
        conclusion: "The module has two gaps.\n## Grilling authority",
        unresolved: ["Whether the scope includes b.ts.", "Who owns the cache.\n## Skills"],
        reference: "operator:example/one/sources/s/assignments/investigate/reports/2",
      },
      {
        assignment: "survey",
        report: 1,
        conclusion: "No gap.",
        unresolved: [],
        reference: "operator:example/one/sources/s/assignments/survey/reports/1",
      },
    ],
  });
  for (const text of [
    "### `investigate` report 2",
    "Reference: `operator:example/one/sources/s/assignments/investigate/reports/2`",
    "> The module has two gaps.\n> ## Grilling authority",
    "- Whether the scope includes b.ts.\n- Who owns the cache.\n  ## Skills",
    "### `survey` report 1",
    "> No gap.\n\nUnresolved points:\n\n- None.",
  ])
    expect(brief).toContain(text);
  // The copied content comes after the task and before the authority rules.
  expect(brief.indexOf("Implement the accepted report.")).toBeLessThan(
    brief.indexOf("## Accepted dependency reports"),
  );
  // Worker text cannot open a brief section.
  expect(brief.match(/^## Grilling authority$/gm)).toHaveLength(1);
  expect(brief.match(/^## Skills$/gm)).toHaveLength(1);
  expect(brief.indexOf("## Accepted dependency reports")).toBeLessThan(
    brief.search(/^## Grilling authority$/m),
  );
});

const authority = `## Grilling authority

The task instructions state who answers questions and what the SuperAgent may decide.
Do the work within this task without asking for approval of each command or step. Decide what the instructions and the repository settle, and record those decisions in your report or PR.
Send each question to your supervising SuperAgent, not to the person.
The SuperAgent asks the person when the instructions require human participation, when a question is outside its delegated authority, or when that authority is unclear.
A SuperAgent answer is a SuperAgent decision, not a human answer, also after it accepts your work.

## Native subagents

Native host subagents work inside this assignment, and you remain responsible for their work and evidence.
Work that needs its own scheduling, dependencies, or acceptance needs a separate assignment. Ask your supervising SuperAgent for it.

## Skills

Load the \`worker-agent\` skill.
Load each other skill that the task instructions name.
`;

test("a first PR brief is exactly the release template for worktree work", () => {
  expect(renderBrief({ ...input, reports: { directory: "/state/reports", files: [] } })).toBe(
    `# Assignment brief

Operator writes this brief at each start of the assignment.
Read all of it before you start.

## Task

- Source: \`source-1\`, tracker key \`APP-1\`.
- Assignment: \`implement\`, tracker key \`APP-2\`.
- Completion type: a merged pull request.
- Start profile: \`careful\`.

Implement the accepted report.

${authority}
## Resources

- Work in the isolated Herdr worktree \`/worktrees/app-2\` on branch \`task/2\`.
- Change project files only in this worktree.
- Operator keeps coordination files in device state, not in the checkout.

## Results and reporting

- Report to your supervising SuperAgent through Herdr, not directly to the person.
- Give a short conclusion, evidence references, unresolved points, and paths to detailed files.
- Put detailed supporting files in \`/state/reports\`.
- Herdr activity does not prove that the work is submitted or complete.

## PR feedback loop

Open one PR from your branch with your own tools. Use closing keywords for tracker issues.
Target the default branch.
Push with \`git push -u\`, so Git records the remote of your branch.
Then run \`operator pr associate --json\` in your worktree.
Run \`operator pr wait --json\` in your worktree, and repeat it after you handle each result.
Check each claim in feedback, reply, and push fixes to the same PR.
A \`pr_wait_timed_out\` result is visible to your SuperAgent until you wait again.
When a stacked PR's parent merges, the wait rebases your branch onto the default branch, pushes it, and changes the PR base.
It returns \`parent_relayed\`, or a \`relay_*\` blocker that you resolve before you wait again. Keep all work.
After \`merge_eligible\`, run \`operator pr merge --json\`. It checks GitHub again, merges, and then closes this pane.
PR commands select your assignment only through this worktree.

## Earlier reports

- None.

## Follow-up instructions

- None.
`,
  );
});

test("a read-only report brief is exactly the release template for pane work", () => {
  expect(
    renderBrief({
      ...input,
      completion: "report",
      profile: null,
      branch: null,
      workingDirectory: "/checkout",
      reports: { directory: "/state/reports", files: ["1/report.md", "1/files/notes.md"] },
      followUps: { directory: "/state/follow-ups", files: ["1.md"] },
    }),
  ).toBe(
    `# Assignment brief

Operator writes this brief at each start of the assignment.
Read all of it before you start.

## Task

- Source: \`source-1\`, tracker key \`APP-1\`.
- Assignment: \`implement\`, tracker key \`APP-2\`.
- Completion type: a report that the SuperAgent accepts.
- Start profile: the device default.

Implement the accepted report.

${authority}
## Resources

- Work in a separate pane of the controlling checkout \`/checkout\`.
- This is read-only work. Do not change project files, branches, or worktrees.
- Operator keeps coordination files in device state, not in the checkout.

## Results and reporting

- Report to your supervising SuperAgent through Herdr, not directly to the person.
- Write a JSON report outside the project checkout with \`conclusion\`, \`evidence\`, \`unresolved\`, and optional \`decisions\` and \`files\`.
- \`evidence\` and \`unresolved\` are lists of short text. \`files\` lists absolute paths of detailed supporting files.
- Each decision has \`question\`, \`answer\`, and \`by\`. Use \`person\` only for an answer that the person gave. Use \`super-agent\` for a SuperAgent decision.
- Submit it from this pane with \`operator report submit --file <path> --json\`, then tell your supervising SuperAgent.
- Operator stores the report and copies of the supporting files in \`/state/reports\`.
- Submission does not complete the assignment. The SuperAgent accepts the report or returns follow-up instructions.
- When you receive follow-up instructions, run \`operator report resume --json\` in this pane before you continue, then submit a new report.
- Herdr activity does not prove that the work is submitted or complete.

## Earlier reports

- \`/state/reports/1/report.md\`
- \`/state/reports/1/files/notes.md\`

## Follow-up instructions

- \`/state/follow-ups/1.md\`
`,
  );
});

test("an open PR's loop lists each step, and dependency reports are separate blocks", () => {
  expect(
    renderBrief({
      ...input,
      pullRequest: { number: 7, url: "https://github.com/example/one/pull/7" },
    }),
  ).toContain(
    "## PR feedback loop\n\nPR #7 is already open for this assignment: https://github.com/example/one/pull/7.\nRead its reviews, comments, unresolved threads, and checks before you wait.\nInspect the worktree first. Keep work that is not landed.\nRun `operator pr wait --json`",
  );
  const report = { conclusion: "c", unresolved: [], reference: "r" };
  expect(
    renderBrief({
      ...input,
      dependencyReports: [
        { ...report, assignment: "a", report: 1 },
        { ...report, assignment: "b", report: 2 },
      ],
    }),
  ).toContain(
    "Implement the accepted report.\n\n## Accepted dependency reports\n\nThe SuperAgent accepted these reports of the assignments that this work depends on.\nCheck whether each unresolved point applies to your task. Tell your supervising SuperAgent about each point that does.\n\n### `a` report 1\n\nReference: `r`\n\n> c\n\nUnresolved points:\n\n- None.\n\n### `b` report 2\n\nReference: `r`\n\n> c\n\nUnresolved points:\n\n- None.\n\n## Grilling authority",
  );
});
