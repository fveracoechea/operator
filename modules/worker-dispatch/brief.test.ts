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
