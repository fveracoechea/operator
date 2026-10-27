type HistoryEntry = {
  number: number;
  trigger: string;
  reviewedCommit: string;
  event: string;
  url: string | null;
  /** The posted draft of the round, written to device state for the reviewer. */
  draft: string;
};
type BriefInput = {
  url: string;
  repository: string;
  number: number;
  origin: string;
  head: string;
  worktree: string;
  branch: string;
  draft: string;
  /** The round that the reviewer works on now. */
  round: { number: number; trigger: string };
  /** Earlier posted rounds, oldest first. */
  history: HistoryEntry[];
};

const triggers: Record<string, string> = {
  first: "the first review",
  commits: "new commits on the PR",
  reply: "an author reply",
  resolved: "a thread that the author resolved",
  "re-request": "a renewed review request",
};

function history(input: BriefInput) {
  if (input.history.length === 0) return "";
  return `
## Earlier rounds

Read these drafts before you write the next one. They are the review history of this request.

${input.history
  .map(
    (round) =>
      `- Round ${round.number}, ${triggers[round.trigger] ?? round.trigger}: \`${round.event}\` at \`${round.reviewedCommit}\`${round.url === null ? "" : `, ${round.url}`}. Draft: \`${round.draft}\`.`,
  )
  .join("\n")}
`;
}

/**
 * The running release's reviewer brief. The reviewer writes a draft, and only the CLI posts.
 * It names no runtime agent, because a replacement reads the same brief and the same history.
 */
export function renderReviewerBrief(input: BriefInput) {
  return `# Review brief

Operator writes this brief when it starts the reviewer and when a round starts.
Read all of it before you start.

## Task

- Review PR #${input.number} of \`${input.repository}\`: ${input.url}.
- Origin: ${input.origin === "assignment" ? "the optional reviewer of a PR assignment. Operator posts a comment, also when no blocker remains" : "a review request"}.
- This is round ${input.round.number}, for ${triggers[input.round.trigger] ?? input.round.trigger}.
- The worktree \`${input.worktree}\` is at the PR head \`${input.head}\` on the local branch \`${input.branch}\`.
- Do not run \`gh pr checkout\`, commit, push, or change the PR branch. Operator never pushes this branch.
${history(input)}
## Skills

Load the \`pr-review\` skill and follow its draft rules.
Load each project skill that the changed code needs.

## Draft and post

- Write the draft as JSON to \`${input.draft}\`, outside the worktree.
- Then run \`operator review post ${input.url} --json\` from any folder.
- The CLI checks the PR head and required CI, computes the event, posts the review, and runs your thread replies.
- A refusal names its cause. Correct the draft and run the post again.
- A \`review_head_moved\` result means that the PR changed. Operator moves your worktree and sends you a prompt that names the new commits. Review them, write a new draft, and post again.
- Never post a review, a comment, or a reply through \`gh\` yourself.

## Later rounds

- After the post, stay in your pane. Operator watches the PR and sends you a prompt when a round starts.
- In each round, check each of your open review threads on the PR:
  - A fixed defect needs no reply.
  - Valid pushback from the author gets one \`acknowledge\` reply.
  - A defect that remains gets one \`explain\` reply. When the author resolved that thread, Operator reopens it.
  - A defect from an earlier round that the author did not answer stays in \`blockers\`.

## Reporting

- Report to your supervising SuperAgent through Herdr, not directly to the person.
- Give the posted event and the review URL from the post result.
- Herdr activity does not prove that the review is posted.
`;
}
