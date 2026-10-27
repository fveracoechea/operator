import { expect, test } from "bun:test";
import { renderReviewerBrief } from "./brief.ts";

const input = {
  url: "https://github.com/example/one/pull/7",
  repository: "example/one",
  number: 7,
  origin: "slack",
  head: "abc",
  worktree: "/w/review",
  branch: "review/one-pr-7",
  draft: "/state/reviews/r/draft.json",
};

test("the brief names the draft, the one post command, and no direct GitHub write", () => {
  const brief = renderReviewerBrief(input);
  expect(brief).toContain("`/state/reviews/r/draft.json`");
  expect(brief).toContain("`operator review post https://github.com/example/one/pull/7 --json`");
  expect(brief).toContain("at the PR head `abc` on the local branch `review/one-pr-7`");
  expect(brief).toContain("Load the `pr-review` skill");
  expect(brief).toContain("Never post a review, a comment, or a reply through `gh` yourself.");
  expect(brief).not.toContain("always a comment");
});

test("an assignment reviewer is told that its review is always a comment", () => {
  expect(renderReviewerBrief({ ...input, origin: "assignment" })).toContain(
    "Operator posts a comment, also when no blocker remains",
  );
});
