import { expect, test } from "bun:test";
import { superAgentMessages } from "../../lib/superagent-messages.ts";
import { renderBrief } from "./brief.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";

const input = {
  sourceId: "source-1",
  sourceTrackerKey: "APP-1",
  assignment: "implement",
  trackerKey: "APP-2",
  completion: "pr" as const,
  profile: "careful",
  instructions: "Implement the accepted report.",
  intent: null,
  workingDirectory: "/worktrees/app-2",
  branch: "task/2",
  reports: { directory: "/state/reports", files: ["1.md"] },
  followUps: { directory: "/state/follow-ups", files: [] },
  pullRequest: null,
  dependencyReports: [],
  stack: null,
  internalReview: false,
  review: null,
  promotion: null,
  adoption: null,
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

test.each(["research", "answer", "prototype", "implementation", "review", "pr-feedback"] as const)(
  "%s has a shipped guide and its brief links the resolved absolute path",
  async (name) => {
    const kind = WorkerKinds.resolve(name);
    const guide = Bun.fileURLToPath(
      new URL(`../../../skills/worker-agent/kinds/${name}.md`, import.meta.url),
    );
    expect(kind.guide).toBe(`worker-agent/kinds/${name}.md`);
    expect(await Bun.file(guide).exists()).toBe(true);
    expect((await Bun.file(guide).text()).trim().length).toBeGreaterThan(30);
    const brief = renderBrief({ ...input, kind: { ...kind, guide } });
    expect(brief).toContain(`Worker kind: \`${name}\`. Read \`${guide}\`.`);
  },
);

test("kind guides honor pane overrides and require the conflict-resolution skill", async () => {
  const prototype = await Bun.file(
    new URL("../../../skills/worker-agent/kinds/prototype.md", import.meta.url),
  ).text();
  expect(prototype).toContain("When the brief gives a worktree");
  expect(prototype).toContain("For pane resources, change no project files.");
  const feedback = await Bun.file(
    new URL("../../../skills/worker-agent/kinds/pr-feedback.md", import.meta.url),
  ).text();
  expect(feedback).toContain("Load `resolving-merge-conflicts`");
});

test("a skill-path fallback retains the guide's condition and permits an absent optional file", () => {
  const brief = renderBrief({
    ...input,
    kind: {
      ...WorkerKinds.resolve("answer"),
      guide: "/owned/worker-agent/kinds/answer.md",
      skillsToRead: ["/upstream/show-me/SKILL.md"],
    },
  });
  expect(brief).toContain(
    "When the guide calls for it and the file exists, read skill by path: `/upstream/show-me/SKILL.md`.",
  );
  expect(brief).not.toContain("\nRead skill by path:");
  expect(renderBrief({ ...input, kind: WorkerKinds.resolve("research") })).not.toContain(
    "read skill by path:",
  );
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

test("the person's intent follows the task as quoted acceptance criteria", () => {
  expect(renderBrief(input)).not.toContain("Acceptance criteria");
  const brief = renderBrief({
    ...input,
    intent: "Stop typing into my pane.\n## Skills\nKeep it small.",
  });
  expect(brief).toContain(`Implement the accepted report.

## Acceptance criteria

The person gave these words for this work. They are its acceptance criteria.
The task instructions above are the SuperAgent's spec for meeting them. Ask your supervising SuperAgent when the two disagree.

> Stop typing into my pane.
> ## Skills
> Keep it small.

## Grilling authority`);
  expect(brief.match(/^## Skills$/gm)).toHaveLength(1);
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

test("a PR brief allows only the read-only gh stack command, also for a stacked draft", () => {
  const rule = `Use \`gh stack view --json\` only to read a stack.
Run no other \`gh stack\` command, because the relay and \`operator pr merge\` own the rebase, push, base change, and merge.`;
  const stack = { assignment: "parent", number: 6, branch: "task/1-parent" };
  for (const brief of [
    renderBrief(input),
    renderBrief({
      ...input,
      pullRequest: { number: 7, url: "https://github.com/example/one/pull/7" },
    }),
    renderBrief({ ...input, stack, internalReview: true }),
  ])
    expect(brief.split(rule)).toHaveLength(2);
  expect(renderBrief({ ...input, internalReview: true })).not.toContain("gh stack");
  expect(renderBrief({ ...input, completion: "report" })).not.toContain("gh stack");
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

- Report to your supervising SuperAgent only through recorded Operator state, not directly to the person. Never type into its pane.
- In the PR body, give a short conclusion, evidence references, and unresolved points.
- Put detailed supporting files in \`/state/reports\`, where your SuperAgent reads them.
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
Use \`gh stack view --json\` only to read a stack.
Run no other \`gh stack\` command, because the relay and \`operator pr merge\` own the rebase, push, base change, and merge.
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

- Report to your supervising SuperAgent only through recorded Operator state, not directly to the person. Never type into its pane.
- Write a JSON report outside the project checkout with \`conclusion\`, \`evidence\`, \`unresolved\`, and optional \`decisions\` and \`files\`.
- \`evidence\` and \`unresolved\` are lists of short text. \`files\` lists absolute paths of detailed supporting files.
- Each decision has \`question\`, \`answer\`, and \`by\`. Use \`person\` only for an answer that the person gave. Use \`super-agent\` for a SuperAgent decision.
- Submit it from this pane with \`operator report submit --file <path> --json\`. Your SuperAgent's coordination wait returns it, so send no message.
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
    "Implement the accepted report.\n\n## Accepted dependency reports\n\nThe SuperAgent accepted these reports of the assignments that this work depends on.\nCheck whether each unresolved point applies to your task. Record a question for your supervising SuperAgent about each point that does.\n\n### `a` report 1\n\nReference: `r`\n\n> c\n\nUnresolved points:\n\n- None.\n\n### `b` report 2\n\nReference: `r`\n\n> c\n\nUnresolved points:\n\n- None.\n\n## Grilling authority",
  );
});

test("with internal review on, the implementer opens a draft PR, associates it, and stops", () => {
  const brief = renderBrief({ ...input, internalReview: true });
  expect(brief).toContain(`## PR feedback loop

Internal review is on for this assignment.
Open one draft PR from your branch with your own tools. Use closing keywords for tracker issues.
Target the default branch.
Commit all work and push with \`git push -u\`, so Git records the remote of your branch.
Then run \`operator pr associate --json\` in your worktree.
It refuses a PR that is not a draft, and a worktree with uncommitted, untracked, or unpushed work. Fix the cause and run it again.
Do not mark the PR ready for review.
After the association, Operator ends this session and starts a fresh reviewer in this worktree. The reviewer owns the PR until its merge.
Stop once the association succeeds. Your SuperAgent sees the handoff in \`operator next\`, so send it no message.

## Earlier reports`);
  expect(brief).not.toContain("Tell your supervising SuperAgent that the draft PR");
  expect(brief).not.toContain("operator pr wait");
  expect(brief).not.toContain("operator pr merge");
});

test("the launch after a recorded handoff is the internal reviewer, with the recorded rounds", () => {
  const pullRequest = { number: 7, url: "https://github.com/example/one/pull/7" };
  const brief = renderBrief({
    ...input,
    internalReview: true,
    pullRequest,
    review: {
      state: "reviewing",
      rounds: [
        {
          number: 1,
          head: "h1",
          findings: [
            {
              axis: "Spec",
              severity: "blocker",
              location: "a.ts:1",
              claim: "The guard\nis missing.",
            },
          ],
        },
        { number: 2, head: "h2", findings: [] },
      ],
      readyHead: null,
    },
  });
  expect(brief).toContain(`## PR feedback loop

PR #7 is already open for this assignment: https://github.com/example/one/pull/7.
You are the internal reviewer of PR #7. Operator ended the implementer's session and started you in its worktree.
Read the \`internal-review.md\` topic of the \`worker-agent\` skill before you start.
Do not use the PR body, the commit messages, or earlier owner messages as evidence.
Record each round's findings with \`operator pr round --file <findings.json> --json\` before you change code.
Recorded rounds:
- Round 1 at \`h1\`:
  - Spec, blocker, \`a.ts:1\`: The guard is missing.
- Round 2 at \`h2\`: no findings.
End the review with \`operator pr ready --file <summary.json> --json\`. It posts the summary comment and marks the PR ready. Do not mark the PR ready yourself.
Then you own the PR feedback loop below.
Read its reviews, comments, unresolved threads, and checks before you wait.
Inspect the worktree first. Keep work that is not landed.
Run \`operator pr wait --json\` in your worktree`);
  expect(
    renderBrief({
      ...input,
      internalReview: true,
      pullRequest,
      review: { state: "reviewing", rounds: [], readyHead: null },
    }),
  ).toContain("No round is recorded yet.");
  // The role comes from the recorded review, never from a draft state that the brief cannot see.
  for (const review of [
    null,
    { state: "ready" as const, rounds: [], readyHead: "h3" },
    { state: "skipped" as const, rounds: [], readyHead: "h3" },
  ]) {
    const owner = renderBrief({ ...input, internalReview: true, pullRequest, review });
    expect(owner).not.toMatch(/internal reviewer|draft|operator pr round|operator pr ready/);
    expect(owner).toContain("After `merge_eligible`, run `operator pr merge --json`.");
  }
});

test("a launch after the internal review ended is the PR owner, and its brief says how it ended", () => {
  const pullRequest = { number: 7, url: "https://github.com/example/one/pull/7" };
  const rounds = [{ number: 1, head: "h1", findings: [] }];
  expect(
    renderBrief({
      ...input,
      internalReview: true,
      pullRequest,
      review: { state: "ready", rounds, readyHead: "h3" },
    }),
  ).toContain(`PR #7 is already open for this assignment: https://github.com/example/one/pull/7.
The internal review of PR #7 ended ready at \`h3\`.
You own the PR. Record no more review rounds.
Read its reviews, comments, unresolved threads, and checks before you wait.`);
  expect(
    renderBrief({
      ...input,
      internalReview: true,
      pullRequest,
      review: { state: "skipped", rounds: [], readyHead: "h3" },
    }),
  ).toContain(`The internal review of PR #7 was skipped on the person's instruction at \`h3\`.
You own the PR. Record no more review rounds.`);
});

test("with internal review off, the brief names no draft and no internal reviewer", () => {
  for (const pullRequest of [null, { number: 7, url: "https://github.com/example/one/pull/7" }]) {
    const brief = renderBrief({ ...input, pullRequest });
    expect(brief).not.toMatch(/draft|internal review/i);
  }
});

test("a report brief ignores internal review", () => {
  expect(renderBrief({ ...input, completion: "report", internalReview: true })).not.toMatch(
    /draft|internal review/i,
  );
});

test("no brief tells the worker to message its SuperAgent, which it reaches only through records", () => {
  const dependency = {
    assignment: "a",
    report: 1,
    reference: "r",
    conclusion: "c",
    unresolved: ["u"],
  };
  for (const brief of [
    input,
    { ...input, internalReview: true },
    { ...input, pullRequest: { number: 7, url: "https://github.com/example/one/pull/7" } },
    {
      ...input,
      pullRequest: { number: 7, url: "https://github.com/example/one/pull/7" },
      review: { state: "reviewing" as const, rounds: [], readyHead: null },
    },
    {
      ...input,
      pullRequest: { number: 7, url: "https://github.com/example/one/pull/7" },
      review: { state: "skipped" as const, rounds: [], readyHead: "h" },
    },
    { ...input, stack: { assignment: "parent", number: 6, branch: "task/1" } },
    { ...input, promotion: { report: "survey", number: 2 } },
    { ...input, completion: "report" as const, branch: null, dependencyReports: [dependency] },
  ])
    expect(superAgentMessages(renderBrief(brief))).toEqual([]);
});

test("a promoted PR brief names the report and asks to clean the branch before its first push", () => {
  const brief = renderBrief({ ...input, promotion: { report: "survey", number: 2 } });
  expect(brief).toContain(`Implement the accepted report.

## Promotion

The SuperAgent promoted report 2 of \`survey\` into this PR assignment.
You work in that report's worktree, and its accepted report is listed above.
The worktree can hold prototype changes that the PR must not keep. Clean the branch before your first push.

## Grilling authority`);
  expect(renderBrief(input)).not.toContain("## Promotion");
});

test("an adopted PR's brief follows its draft state and names the base", () => {
  const adoption = {
    number: 41,
    url: "https://github.com/example/one/pull/41",
    draft: false,
    branch: "feature/existing",
  };
  const ready = renderBrief({ ...input, adoption });
  expect(ready).toContain(`## PR feedback loop

You adopt PR #41, which Operator did not open: https://github.com/example/one/pull/41.
Your worktree is on its branch. Do not open another PR, and do not rewrite commits that the PR already has.
Read the PR, its reviews, comments, unresolved review threads, and checks before you change code or wait.
The PR is ready for review, so it gets no internal review.
Target the default branch.
Push your fixes with \`git push -u\`, so Git records the remote of your branch.
Run \`operator pr associate --json\` in your worktree before your first wait.`);
  const draft = renderBrief({ ...input, adoption: { ...adoption, draft: true } });
  expect(draft).toContain("You adopt draft PR #41");
  expect(draft).toContain(
    "Internal review is off for this assignment.\nMark the draft ready for review with `gh pr ready` before your first wait, because the merge needs a ready PR.\nTarget the default branch.",
  );
  expect(draft).not.toContain("The PR is ready for review");
  for (const brief of [ready, draft]) expect(superAgentMessages(brief)).toEqual([]);
});
