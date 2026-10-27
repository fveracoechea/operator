type BriefInput = {
  url: string;
  repository: string;
  number: number;
  origin: string;
  head: string;
  worktree: string;
  branch: string;
  draft: string;
};

/**
 * The running release's reviewer brief. The reviewer writes a draft, and only the CLI posts.
 * It names no runtime agent, because a replacement reads the same brief.
 */
export function renderReviewerBrief(input: BriefInput) {
  return `# Review brief

Operator writes this brief when it starts the reviewer.
Read all of it before you start.

## Task

- Review PR #${input.number} of \`${input.repository}\`: ${input.url}.
- Origin: ${input.origin === "assignment" ? "the optional reviewer of a PR assignment. Operator posts a comment, also when no blocker remains" : "a review request"}.
- The worktree \`${input.worktree}\` is at the PR head \`${input.head}\` on the local branch \`${input.branch}\`.
- Do not run \`gh pr checkout\`, commit, push, or change the PR branch. Operator never pushes this branch.

## Skills

Load the \`pr-review\` skill and follow its draft rules.
Load each project skill that the changed code needs.

## Draft and post

- Write the draft as JSON to \`${input.draft}\`, outside the worktree.
- Then run \`operator review post ${input.url} --json\` from any folder.
- The CLI checks the PR head and required CI, computes the event, and posts the review.
- A refusal names its cause. Correct the draft and run the post again.
- A \`review_head_moved\` refusal means that the PR changed. Tell your supervising SuperAgent and stop. This release does not yet move the reviewer to the new head.
- Never post a review, a comment, or a reply through \`gh\` yourself.

## Reporting

- Report to your supervising SuperAgent through Herdr, not directly to the person.
- Give the posted event and the review URL from the post result.
- Herdr activity does not prove that the review is posted.
`;
}
