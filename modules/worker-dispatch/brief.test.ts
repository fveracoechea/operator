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
  resources: { kind: "worktree" as const, branch: "task/2" },
  reports: { directory: "/state/reports", files: ["1.md"] },
  followUps: { directory: "/state/follow-ups", files: [] },
  pullRequest: null,
  dependencyReports: [],
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
    resources: { kind: "pane" },
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
