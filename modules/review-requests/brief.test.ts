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
  round: { number: 1, trigger: "first" },
  history: [],
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

test("a later round names its trigger and every earlier draft, so a replacement has the history", () => {
  const brief = renderReviewerBrief({
    ...input,
    round: { number: 3, trigger: "reply" },
    history: [
      {
        number: 1,
        trigger: "first",
        reviewedCommit: "c1",
        event: "COMMENT",
        url: "https://github.com/r/1",
        draft: "/state/reviews/r/rounds/1.json",
      },
      {
        number: 2,
        trigger: "commits",
        reviewedCommit: "c2",
        event: "REQUEST_CHANGES",
        url: null,
        draft: "/state/reviews/r/rounds/2.json",
      },
    ],
  });
  expect(brief).toContain("This is round 3, for an author reply.");
  expect(brief).toContain(
    "- Round 1, the first review: `COMMENT` at `c1`, https://github.com/r/1. Draft: `/state/reviews/r/rounds/1.json`.",
  );
  expect(brief).toContain(
    "- Round 2, new commits on the PR: `REQUEST_CHANGES` at `c2`. Draft: `/state/reviews/r/rounds/2.json`.",
  );
  expect(brief).toContain(
    "A defect from an earlier round that the author did not answer stays in `blockers`.",
  );
  expect(renderReviewerBrief(input)).not.toContain("## Earlier rounds");
});

test("each trigger has its words, and a request names its origin", () => {
  const brief = renderReviewerBrief({
    ...input,
    round: { number: 4, trigger: "re-request" },
    history: [
      {
        number: 2,
        trigger: "resolved",
        reviewedCommit: "c2",
        event: "COMMENT",
        url: null,
        draft: "/d/2.json",
      },
      {
        number: 3,
        trigger: "other",
        reviewedCommit: "c3",
        event: "APPROVE",
        url: null,
        draft: "/d/3.json",
      },
    ],
  });
  expect(brief).toContain("- Origin: a review request.\n");
  expect(brief).toContain("This is round 4, for a renewed review request.");
  expect(brief).toContain(
    "- Round 2, a thread that the author resolved: `COMMENT` at `c2`. Draft: `/d/2.json`.\n- Round 3, other: `APPROVE` at `c3`. Draft: `/d/3.json`.\n",
  );
  expect(renderReviewerBrief(input)).toContain("Operator never pushes this branch.\n\n## Skills");
});
